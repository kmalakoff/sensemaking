import assert from 'assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Row } from 'sensemaking';
import { find, mapTree, peek } from 'sensemaking';
import { packageRoot, runCli } from '../lib/cli.ts';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

function makeTree(): string {
  const baseDir = tmpTree();
  write(baseDir, 'floor.md', 'The price floor is 100 credits. See [[context]] for why.', { title: 'Pricing floor', status: 'active' });
  write(baseDir, 'context.md', 'Background that never mentions the c-word or the s-word.', { title: 'Context', status: 'active' });
  write(baseDir, 'archived.md', 'Old price discussion, superseded.', { title: 'Old', status: 'archived' });
  write(baseDir, 'unrelated.md', 'Gardening notes.', { title: 'Gardening', status: 'active' });
  return baseDir;
}

describe('find', () => {
  it('BM25 matches carry via=match with a snippet', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string; hit: string }>;
    const floor = rows.find((r) => r.path === 'floor.md');
    assert.ok(floor, `expected floor.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.ok(floor.via.includes('match'));
    assert.ok(/«pric/i.test(floor.hit), `no highlighted match in: ${floor.hit}`);
  });

  it('link expansion surfaces a connected note that never contains the terms, via=link', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    const connected = rows.find((r) => r.path === 'context.md');
    assert.ok(connected, `expected context.md in results: ${JSON.stringify(rows.map((r) => r.path))}`);
    assert.equal(connected.via, 'link');
  });

  it('--where composes a frontmatter filter with the fused ranking', async () => {
    const { db, cfg } = openTree(makeTree());
    const rows = (await find(db, cfg, 'price', { where: "f.status = 'active'" })) as Array<{ path: string }>;
    assert.ok(rows.every((r) => r.path !== 'archived.md'));
    assert.ok(rows.some((r) => r.path === 'floor.md'));
  });

  it('terms pass verbatim: invalid FTS5 syntax errors loudly', async () => {
    const { db, cfg } = openTree(makeTree());
    await assert.rejects(find(db, cfg, 'price AND AND'), /fts5|syntax/);
  });

  it('terms pass verbatim: bare words AND-join, so an absent word means zero rows', async () => {
    const { db, cfg } = openTree(makeTree());
    assert.deepEqual(await find(db, cfg, 'price nonexistentword'), []);
    const rows = (await find(db, cfg, 'price OR nonexistentword')) as Array<{ path: string }>;
    assert.ok(
      rows.some((r) => r.path === 'floor.md'),
      'explicit OR is the caller expressing intent'
    );
  });

  it('with links disabled it degrades to BM25-only', async () => {
    const { db, cfg } = openTree(makeTree(), { links: false });
    const rows = (await find(db, cfg, 'price')) as Array<{ path: string; via: string }>;
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.via === 'match'));
    assert.ok(!rows.some((r) => r.path === 'context.md'));
  });
});

describe('mapTree', () => {
  it('reports counts, field coverage, hubs, and recent', () => {
    const { db, cfg } = openTree(makeTree());
    const result = mapTree(db, cfg);
    assert.equal(result.docs.count, 4);
    const status = result.fields.find((f: Row) => f.field === 'status');
    assert.equal(status?.coverage, 4);
    assert.ok(!result.fields.some((f: Row) => f.field === '_rank'), 'internal columns are not fields');
    assert.ok(
      (result.hubs as Array<{ path: string }>).some((h) => h.path === 'context.md'),
      'the linked-to note is a hub'
    );
    assert.equal(result.recent.length, 4);
  });

  it('without rank there are no hubs, everything else stands', () => {
    const { db, cfg } = openTree(makeTree(), { rank: false });
    const result = mapTree(db, cfg);
    assert.deepEqual(result.hubs, []);
    assert.equal(result.docs.count, 4);
  });
});

describe('peek', () => {
  function structured(): string {
    const baseDir = tmpTree();
    write(baseDir, 'note.md', '# Alpha\n\nprose\n\n## Beta\n\nmore [[other]] prose\n', { title: 'Structured', tags: ['x'] });
    write(baseDir, 'other.md', 'links back to [[note]]');
    return baseDir;
  }

  it('returns frontmatter, outline with line ranges, and links both ways', () => {
    const { db, cfg } = openTree(structured());
    const result = peek(db, cfg, 'note.md');
    assert.equal(result.frontmatter.title, 'Structured');
    assert.equal(result.sections.length, 2);
    assert.equal(result.sections[0].heading, 'Alpha');
    assert.ok((result.sections[0].start_line as number) > 0);
    assert.deepEqual(result.outbound, ['other.md']);
    assert.deepEqual(result.backlinks, ['other.md']);
    assert.ok(result.tokens > 0);
  });

  it('resolves a bare basename when unique', () => {
    const { db, cfg } = openTree(structured());
    const result = peek(db, cfg, 'note');
    assert.equal(result.path, 'note.md');
  });

  it('unknown path throws with a message', () => {
    const { db, cfg } = openTree(structured());
    assert.throws(() => peek(db, cfg, 'missing'), /no note matches/);
  });
});

describe('peek stays bounded', () => {
  it('caps link lists at 20 and reports totals', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the target everyone cites');
    for (let i = 0; i < 30; i++) write(baseDir, `n${String(i).padStart(2, '0')}.md`, 'cites [[hub]]');

    const { db, cfg } = openTree(baseDir);
    const result = peek(db, cfg, 'hub.md');
    assert.equal(result.backlinksTotal, 30);
    assert.equal(result.backlinks.length, 20);
  });
});

describe('--version', () => {
  it('prints the package.json version', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const result = runCli(['--version']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `v${pkg.version}`);
  });
});

describe('mapTree truncation is reported', () => {
  it('fieldsTotal carries the real count when fields exceed 20', () => {
    const baseDir = tmpTree();
    const fm: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) fm[`field${String(i).padStart(2, '0')}`] = 'v';
    write(baseDir, 'wide.md', 'body', fm);

    const { db, cfg } = openTree(baseDir);
    const result = mapTree(db, cfg);
    assert.equal(result.fields.length, 20);
    assert.equal(result.fieldsTotal, 25);
  });
});

describe('find --where applies before the candidate cut', () => {
  it('finds a filtered match ranked past the BM25 candidate pool', async () => {
    const baseDir = tmpTree();
    // 40 archived notes with a title hit outrank one active note with a body-only
    // mention; the candidate pool is max(k*3, 30), so a post-filter would return [].
    for (let i = 0; i < 40; i++) write(baseDir, `arch${String(i).padStart(2, '0')}.md`, 'widget specs here', { title: `Widget ${i}`, status: 'archived' });
    write(baseDir, 'live.md', 'A much longer note that mentions a widget once among many other unrelated words about several other topics entirely.', { title: 'Operations', status: 'active' });

    const { db, cfg } = openTree(baseDir);
    const rows = (await find(db, cfg, 'widget', { where: "f.status = 'active'" })) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['live.md']
    );
  });

  it('link-derived rows still respect the filter', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'hit.md', 'gadget details, see [[linked-archived]] and [[linked-active]]', { title: 'Gadget', status: 'active' });
    write(baseDir, 'linked-archived.md', 'no matching terms here', { title: 'Old', status: 'archived' });
    write(baseDir, 'linked-active.md', 'no matching terms here either', { title: 'Ref', status: 'active' });

    const { db, cfg } = openTree(baseDir);
    const rows = (await find(db, cfg, 'gadget', { where: "f.status = 'active'" })) as Array<{ path: string; via: string }>;
    assert.ok(
      rows.some((r) => r.path === 'linked-active.md'),
      `expected linked-active via link: ${JSON.stringify(rows)}`
    );
    assert.ok(!rows.some((r) => r.path === 'linked-archived.md'), 'archived link-derived row must be filtered');
  });
});

describe('find provenance', () => {
  it('linkless tree: via is match only, never link', async () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'alpha topic content' });
    writeNote(base, 'b.md', { body: 'alpha adjacent content' });
    const { db, cfg } = openTree(base);
    const rows = await find(db, cfg, 'alpha');
    assert.ok(rows.length >= 2);
    for (const row of rows) assert.equal(row.via, 'match', `expected match, got ${row.via} for ${row.path}`);
    db.close();
  });

  it('linked tree: a seed with no incident edge stays via match', async () => {
    const base = tmpTree();
    writeNote(base, 'hub.md', { body: 'alpha hub, see [[spoke]]' });
    writeNote(base, 'spoke.md', { body: 'spoke detail' });
    writeNote(base, 'island.md', { body: 'alpha island, no links at all' });
    const { db, cfg } = openTree(base);
    const rows = await find(db, cfg, 'alpha');
    const island = rows.find((r) => r.path === 'island.md');
    assert.ok(island, 'island matched');
    assert.equal(island.via, 'match');
    db.close();
  });
});

describe('feature visibility', () => {
  it('map reports feature states; disabled features carry their config key', () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: 'alpha' });
    const { db, cfg } = openTree(base, { rank: false, embed: false });
    const result = mapTree(db, cfg);
    assert.deepEqual(result.features.on, ['links', 'sections']);
    assert.deepEqual(result.features.off, ['rank', 'embed']);
    db.close();
  });

  it('peek distinguishes off from empty: sections off is reported, not silent', () => {
    const base = tmpTree();
    writeNote(base, 'a.md', { body: '# Heading\n\nalpha' });
    const { db, cfg } = openTree(base, { sections: false });
    const result = peek(db, cfg, 'a.md');
    assert.deepEqual(result.sections, []);
    assert.ok(result.off.includes('sections'));
    db.close();
  });
});
