import assert from 'node:assert';
import { openTreeForStore, STORE_NAMES } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

async function docCount(store: Awaited<ReturnType<typeof openTreeForStore>>['store']): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return Number(((await stmt.get()) as { n: number | bigint }).n);
}

// The same fixture tree indexed by both stores; sqlite is the reference implementation
// (principle 1). This slice's duckdb store covers the portable surface only (frontmatter,
// links/backlinks, sections, tags, docCount) -- no lexical/vector search yet, so this file
// asserts parity on exactly that surface.

function fixtureTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', {
    frontmatter: { title: 'Alpha', priority: 5, tags: ['x', 'y'], active: true },
    body: '# Intro\n\nSee [[b]] and [[b]] again, plus an embed ![[b]].\n\n## Details\n\nMore #inline-tag text.',
  });
  writeNote(baseDir, 'b.md', {
    frontmatter: { title: 'Beta', priority: 'high' },
    body: 'target note, linked back to [[a]].',
  });
  writeNote(baseDir, 'c.md', {
    frontmatter: { title: 'Gamma' },
    body: 'unlinked note.',
  });
  return baseDir;
}

describe('store parity: portable surface (sqlite vs duckdb)', () => {
  it('docCount agrees', async () => {
    const baseDir = fixtureTree();
    const results = await Promise.all(STORE_NAMES.map((store) => openTreeForStore(store, baseDir)));
    const counts = await Promise.all(results.map((r) => docCount(r.store)));
    assert.deepEqual(counts, [3, 3]);
    await Promise.all(results.map((r) => r.store.close()));
  });

  it('frontmatter values agree, including mixed-type dynamic columns and has()', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const rows = (await (await s.prepare('SELECT "path", title, priority FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; title: string; priority: unknown }>;
      assert.deepEqual(
        rows.map((r) => [r.path, r.title, String(r.priority)]),
        [
          ['a.md', 'Alpha', '5'],
          ['b.md', 'Beta', 'high'],
          ['c.md', 'Gamma', 'null'],
        ],
        store
      );
      const hasRow = (await (await s.prepare(`SELECT has(tags, 'x') AS hx, has(tags, 'z') AS hz FROM frontmatter WHERE "path" = ?`)).get('a.md')) as { hx: unknown; hz: unknown };
      assert.equal(Number(hasRow.hx), 1, store);
      assert.equal(Number(hasRow.hz), 0, store);
      await s.close();
    }
  });

  it('docs.columns() agrees on the discovered frontmatter keys', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const columns = new Set(await s.docs.columns());
      for (const expected of ['path', 'title', 'priority', 'tags', 'active']) assert.ok(columns.has(expected), `${store} missing column ${expected}`);
      await s.close();
    }
  });

  it('links and backlinks agree (wikilink + embed grain, dedup on second identical link)', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const outbound = (await (await s.prepare('SELECT dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<{ dst: string; embed: number }>;
      assert.deepEqual(
        outbound.map((r) => [r.dst, Number(r.embed)]),
        [
          ['b.md', 0],
          ['b.md', 1],
        ],
        store
      );
      const backlinks = (await (await s.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst ORDER BY src')).all('b.md')) as Array<{ src: string }>;
      assert.deepEqual(
        backlinks.map((r) => r.src),
        ['a.md'],
        store
      );
      await s.close();
    }
  });

  it('sections agree', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const sections = (await (await s.prepare('SELECT heading, level FROM sections WHERE "path" = ? ORDER BY idx')).all('a.md')) as Array<{ heading: string; level: number }>;
      assert.deepEqual(
        sections.map((r) => [r.heading, Number(r.level)]),
        [
          ['Intro', 1],
          ['Details', 2],
        ],
        store
      );
      await s.close();
    }
  });

  it('tags agree (frontmatter list + inline #tag)', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const tags = (await (await s.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
      assert.deepEqual(
        tags.map((r) => r.tag),
        ['inline-tag', 'x', 'y'],
        store
      );
      await s.close();
    }
  });

  it('rank (_rank) agrees on sign and ordering across the tree', async () => {
    const baseDir = fixtureTree();
    const orders: string[][] = [];
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const rows = (await (await s.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC, "path"')).all()) as Array<{ path: string; _rank: number }>;
      assert.ok(
        rows.every((r) => typeof r._rank === 'number'),
        store
      );
      orders.push(rows.map((r) => r.path));
      await s.close();
    }
    assert.deepEqual(orders[0], orders[1]);
  });
});
