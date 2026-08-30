import assert from 'node:assert';
import { writeModel } from '../../../lib/model.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string, embed?: Parameters<typeof openConfig>[0]['embed']) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, embed, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('createStore (duckdb)', () => {
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

  it('vectors.pending()/hasVector()/writeVectors() work end to end through reconcile-created rows (D2)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' }, body: 'apple' });
    const { store } = await duckdbTree(baseDir, { model: writeModel(), provider: 'static' });
    const pending = await store.vectors.pending();
    assert.deepEqual(pending, [{ path: 'a.md', chunk: 0 }]);
    assert.equal(await store.vectors.hasVector('a.md'), false);

    await store.vectors.writeVectors([{ path: 'a.md', chunk: 0, scale: 1, vector: Buffer.from(Int8Array.from([100, 0, 0, 0, 0, 0, 0, 0]).buffer) }]);
    assert.equal(await store.vectors.hasVector('a.md'), true);
    assert.deepEqual(await store.vectors.pending(), []);
    await store.close();
  });

  it('lexical.query() finds a word match by path (D1)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const hits = await store.lexical.query('body', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md', 'b.md']
    );
    await store.close();
  });
});
