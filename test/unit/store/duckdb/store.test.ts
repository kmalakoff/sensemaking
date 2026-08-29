import assert from 'node:assert';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('createStore (duckdb)', () => {
  it('declares its name and an empty capability set (no lexical/vectors this slice)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await duckdbTree(baseDir);
    assert.equal(store.name, 'duckdb');
    assert.deepEqual([...store.capabilities], []);
    await store.close();
  });

  it('docs.columns() returns frontmatter column names, including dynamic keys', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const { store } = await duckdbTree(baseDir);
    const columns = await store.docs.columns();
    assert.ok(columns.includes('title'));
    assert.ok(columns.includes('tags'));
    assert.ok(columns.includes('path'));
    await store.close();
  });

  it('raw.prepare() streams rows through its async iterator', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const stmt = await store.raw.prepare('SELECT "path" FROM frontmatter ORDER BY "path"');
    const rows: unknown[] = [];
    for await (const row of stmt.iterate()) rows.push(row);
    assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }]);
    await store.close();
  });

  it('raw.prepare() reads int64 values past 2^53 as BigInt', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await duckdbTree(baseDir);
    const stmt = await store.raw.prepare('SELECT 9007199254740993 AS big');
    const rows: Array<{ big: unknown }> = [];
    for await (const row of stmt.iterate()) rows.push(row as { big: unknown });
    assert.equal(typeof rows[0].big, 'bigint');
    assert.equal(rows[0].big, BigInt('9007199254740993'));
    await store.close();
  });

  it('raw sql can call the registered has()/basename() functions', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'notes/a.md', { frontmatter: { title: 'A', tags: ['x', 'y'] } });
    const { store } = await duckdbTree(baseDir);
    const hasStmt = await store.raw.prepare(`SELECT has(tags, 'x') AS hx, has(tags, 'z') AS hz FROM frontmatter`);
    const hasRows: Array<{ hx: unknown; hz: unknown }> = [];
    for await (const row of hasStmt.iterate()) hasRows.push(row as { hx: unknown; hz: unknown });
    assert.equal(hasRows[0].hx, 1);
    assert.equal(hasRows[0].hz, 0);

    const baseStmt = await store.raw.prepare(`SELECT basename("path") AS b FROM frontmatter`);
    const baseRows: Array<{ b: unknown }> = [];
    for await (const row of baseStmt.iterate()) baseRows.push(row as { b: unknown });
    assert.equal(baseRows[0].b, 'a.md');
    await store.close();
  });

  it('lexical.query() and vectors.* fail loudly rather than silently returning nothing', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await duckdbTree(baseDir);
    await assert.rejects(() => store.lexical.query('x', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 }), /STORE_CAPABILITY_MISSING|does not implement/);
    await assert.rejects(() => store.vectors.pending(), /STORE_CAPABILITY_MISSING|does not implement/);
    await assert.rejects(() => store.vectors.hasVector('a.md'), /STORE_CAPABILITY_MISSING|does not implement/);
    await store.close();
  });
});
