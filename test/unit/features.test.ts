import assert from 'assert';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
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
