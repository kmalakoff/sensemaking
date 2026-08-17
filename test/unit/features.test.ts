import assert from 'node:assert';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rebuild } from 'sensemaking';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

describe('links feature', () => {
  it('wikilinks resolve by basename; aliases, anchors, and embeds are handled', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]], [[b#section|the alias]], and ![[c]].');
    write(baseDir, 'b.md', 'target one');
    write(baseDir, 'c.md', 'target two');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target, dst FROM links WHERE src = ? ORDER BY target').all('a.md') as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'b', dst: 'b.md' },
      { target: 'c', dst: 'c.md' },
    ]);
  });

  it('relative markdown links resolve; external URLs are ignored', () => {
    const baseDir = tmpTree();
    mkdirSync(join(baseDir, 'sub'));
    write(baseDir, 'sub/a.md', '[sibling](b.md) and [outside](https://example.com/x.md)');
    write(baseDir, 'sub/b.md', 'target');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT dst FROM links WHERE src = ?').all('sub/a.md') as Array<{ dst: string | null }>;
    assert.deepEqual(
      rows.map((r) => r.dst),
      ['sub/b.md']
    );
  });

  it('a dead link has NULL dst, and resolves when the target appears later', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'Mentions [[future-note]] before it exists.');

    const first = openTree(baseDir);
    const dead = first.db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(dead.dst, null);
    first.db.close();

    write(baseDir, 'future-note.md', 'now it exists');
    const second = openTree(baseDir);
    const live = second.db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(live.dst, 'future-note.md');
    second.db.close();
  });

  it('deleting a target turns its backlinks back into dead links', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'Links to [[b]].');
    write(baseDir, 'b.md', 'target');

    const first = openTree(baseDir);
    first.db.close();

    rmSync(join(baseDir, 'b.md'));
    const second = openTree(baseDir);
    const row = second.db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(row.dst, null);
    second.db.close();
  });

  it('disabled: no links table', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]].');
    write(baseDir, 'b.md', 'target');

    const { db } = openTree(baseDir, { links: false });
    assert.throws(() => db.prepare('SELECT * FROM links').all(), /no such table/);
  });

  it('toggling a feature rebuilds the cache', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]].');
    write(baseDir, 'b.md', 'target');

    const first = openTree(baseDir, { links: false });
    first.db.close();

    const second = openTree(baseDir);
    assert.equal(second.parsed, 2, 'feature toggle should force a full re-crawl');
    const rows = second.db.prepare('SELECT COUNT(*) AS n FROM links').get() as { n: number };
    assert.equal(rows.n, 1);
    second.db.close();
  });

  it('incremental resolve: deleting the lexicographically-first of two same-basename files re-points existing links to the survivor', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a/dup.md', 'target A');
    write(baseDir, 'b/dup.md', 'target B');
    write(baseDir, 'src.md', 'See [[dup]].');
    for (let i = 0; i < 7; i++) write(baseDir, `filler${i}.md`, 'filler');

    const first = openTree(baseDir);
    const before = first.db.prepare('SELECT dst FROM links WHERE src = ?').get('src.md') as { dst: string };
    assert.equal(before.dst, 'a/dup.md', 'lexicographically-first wins the tie');
    first.db.close();

    // one file removed out of ten stays well under the incremental/full-fallback ratio
    rmSync(join(baseDir, 'a/dup.md'));
    const second = openTree(baseDir);
    const after = second.db.prepare('SELECT dst FROM links WHERE src = ?').get('src.md') as { dst: string };
    assert.equal(after.dst, 'b/dup.md', 'removing the tie-winner should re-point to the survivor');
    second.db.close();
  });

  it('incremental resolve matches a full rebuild byte-for-byte after add/delete/modify', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the hub');
    write(baseDir, 'a.md', 'See [[hub]] and [[missing]].');
    write(baseDir, 'sub/b.md', '[relative](../hub.md)');
    for (let i = 0; i < 13; i++) write(baseDir, `filler${i}.md`, `mentions [[filler${(i + 1) % 13}]]`);

    const first = openTree(baseDir);
    first.db.close();

    // add + delete + modify in one reconcile, still under the 20% churn threshold (3 of 16 files)
    write(baseDir, 'new.md', 'points at [[a]]');
    rmSync(join(baseDir, 'filler12.md'));
    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', 'See [[hub]] and [[missing]], now also [[sub/b]].');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const incremental = openTree(baseDir);
    const incrementalRows = incremental.db.prepare('SELECT src, target, dst FROM links ORDER BY src, target').all();
    incremental.db.close();

    const rebuilt = rebuild({ presets: { default: { include: ['**/*.md'], semantic: false } }, queries: {}, baseDir, configPath: null });
    const rebuiltRows = rebuilt.db.prepare('SELECT src, target, dst FROM links ORDER BY src, target').all();
    rebuilt.db.close();

    assert.deepEqual(incrementalRows, rebuiltRows);
  });
});

describe('sections feature', () => {
  it('headings become rows with 1-indexed line ranges over the raw file and token estimates', () => {
    const baseDir = tmpTree();
    // frontmatter occupies lines 1-3; body starts at line 4 (blank), heading on line 5
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: A\n---\n\n# First\n\nprose here\n\n## Second\n\nmore prose\n');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx').all('a.md') as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { level: 1, heading: 'First', start_line: 5, end_line: 8, tokens: rows[0].tokens });
    assert.equal(rows[1].heading, 'Second');
    assert.equal(rows[1].start_line, 9);
    assert.ok((rows[0].tokens as number) > 0);
  });

  it('headings inside fenced code blocks are not sections', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '# Real\n\n```\n# not a heading\n```\n');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT heading FROM sections WHERE "path" = ?').all('a.md') as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['Real']
    );
  });
});

describe('rank feature', () => {
  it('a heavily linked note outranks a leaf', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the center');
    write(baseDir, 'a.md', 'points at [[hub]]');
    write(baseDir, 'b.md', 'points at [[hub]]');
    write(baseDir, 'c.md', 'points at [[hub]] and [[a]]');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC').all() as Array<{ path: string; _rank: number }>;
    assert.equal(rows[0].path, 'hub.md');
    assert.ok(rows[0]._rank > rows[rows.length - 1]._rank);
  });

  it('rank recomputes when links change', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'no links yet');
    write(baseDir, 'b.md', 'none here either');

    const first = openTree(baseDir);
    first.db.close();

    write(baseDir, 'a.md', 'now points at [[b]], twice: [[b]]');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const rows = second.db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC').all() as Array<{ path: string }>;
    assert.equal(rows[0].path, 'b.md');
    second.db.close();
  });

  it('recompute is skipped when the reconcile touched no link rows', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'first body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    // plant an otherwise-impossible rank value; a recompute would overwrite it with the real one
    const probe = openTree(baseDir); // nothing changed since `first` -> no-op reconcile, no afterReconcile call
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    // hub.md has no outbound links, so reparsing it touches no link rows
    const future = new Date(Date.now() + 5000);
    write(baseDir, 'hub.md', 'second body, still no links');
    utimesSync(join(baseDir, 'hub.md'), future, future);

    const second = openTree(baseDir);
    const row = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    assert.equal(row._rank, 999, 'rank recompute should have been skipped, leaving the planted value in place');
    second.db.close();
  });

  it('a touch-only reparse of a linked note keeps dst and skips the rank recompute', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    // same content, newer mtime: the links are re-stored but no edge changed
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    const link = second.db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(hub._rank, 999, 'no edge changed, so the recompute must be skipped');
    assert.equal(link.dst, 'hub.md', 'the preserved row must keep its resolved dst');
    second.db.close();
  });

  it('adding a linkless note recomputes: the node set changed even though no edge did', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    write(baseDir, 'newcomer.md', 'no links here, none point at me');

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    const fresh = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('newcomer.md') as { _rank: number | null };
    assert.notEqual(hub._rank, 999, 'the planted value should have been overwritten by a recompute');
    assert.ok(fresh._rank !== null, 'the new note must get a rank, not stay NULL');
    second.db.close();
  });

  it('reparsing a note down to zero links recomputes: its old rows carried edges', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', 'the link is gone now');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    assert.notEqual(hub._rank, 999, 'losing the last inbound edge must trigger a recompute');
    second.db.close();
  });
});

describe('lenient frontmatter', () => {
  it('a syntax error is a warning; the values still parse (Obsidian-style @ alias)', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'handle.md'), '---\naliases:\n- @someone\ntags:\n- \npublish: true\n---\n\nsearchable prose with [[good]]\n');
    write(baseDir, 'good.md', 'fine');

    const result = openTree(baseDir);
    assert.ok(
      result.warnings.some((w) => w.includes('handle.md') && w.includes('parsed leniently')),
      `expected warning: ${result.warnings}`
    );
    const row = result.db.prepare('SELECT aliases, publish FROM frontmatter WHERE path = ?').get('handle.md') as Record<string, unknown>;
    assert.equal(row.aliases, '["@someone"]', 'the @ value survives');
    assert.equal(row.publish, 1);
    assert.equal((result.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('searchable') as { n: number }).n, 1);
    const link = result.db.prepare('SELECT dst FROM links WHERE src = ?').get('handle.md') as { dst: string };
    assert.equal(link.dst, 'good.md');
  });

  it('non-mapping frontmatter is ignored with a warning; the file still indexes', () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'scalar.md'), '---\njust a string\n---\n\nprose\n');

    const result = openTree(baseDir);
    assert.ok(
      result.warnings.some((w) => w.includes('scalar.md') && w.includes('not a key-value mapping')),
      `expected warning: ${result.warnings}`
    );
    assert.equal((result.db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number }).n, 1);
  });
});
