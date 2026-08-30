import assert from 'node:assert';
import { writeModel } from '../../../lib/model.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function tursoTree(baseDir: string, embed?: Parameters<typeof openConfig>[0]['embed']) {
  return openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, embed, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('createStore (turso)', () => {
  it('the general (non-raw) prepare() does not enable safeIntegers: values past 2^53 come back lossy', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await tursoTree(baseDir);
    const row = (await (await store.prepare('SELECT 9007199254740993 AS big')).get()) as { big: unknown };
    assert.equal(typeof row.big, 'number');
    await store.close();
  });

  it('engineStatus() reports a derived busy_timeout', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await tursoTree(baseDir);
    const engine = await store.engineStatus();
    const m = engine.busy_timeout.match(/^(\d+)ms/);
    assert.ok(m, `engine.busy_timeout ${engine.busy_timeout} not of the form "<n>ms ..."`);
    assert.ok(Number(m[1]) >= 30000);
    await store.close();
  });

  it('vectors.pending()/hasVector() work against a real embeddings table -- the reused, engine-neutral helpers sqlite/duckdb also use', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await tursoTree(baseDir);
    await store.exec('CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))');
    await store.exec(`INSERT INTO embeddings ("path", chunk, scale, vector) VALUES ('a.md', 0, NULL, NULL)`);
    assert.deepEqual(await store.vectors.pending(), [{ path: 'a.md', chunk: 0 }]);
    assert.equal(await store.vectors.hasVector('a.md'), false);
    await store.exec(`UPDATE embeddings SET vector = X'00' WHERE "path" = 'a.md' AND chunk = 0`);
    assert.equal(await store.vectors.hasVector('a.md'), true);
    assert.deepEqual(await store.vectors.pending(), []);
    await store.close();
  });

  it('vectors.pending()/hasVector()/writeVectors()/candidates()/similar() work end to end through reconcile-created rows (T2)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' }, body: 'apple' });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' }, body: 'banana' });
    const { store } = await tursoTree(baseDir, { model: writeModel(), provider: 'static' });
    const pending = await store.vectors.pending();
    assert.deepEqual(
      pending.map((p) => p.path),
      ['a.md', 'b.md']
    );
    assert.equal(await store.vectors.hasVector('a.md'), false);

    const dims = 8;
    await store.vectors.writeVectors([
      { path: 'a.md', chunk: 0, scale: 1, vector: Buffer.from(Int8Array.from([100, 0, 0, 0, 0, 0, 0, 0]).buffer) },
      { path: 'b.md', chunk: 0, scale: 1, vector: Buffer.from(Int8Array.from([0, 100, 0, 0, 0, 0, 0, 0]).buffer) },
    ]);
    assert.equal(await store.vectors.hasVector('a.md'), true);
    assert.deepEqual(await store.vectors.pending(), []);

    const qv = new Float32Array(dims);
    qv[0] = 1;
    const candidates = await store.vectors.candidates(qv, dims, 10);
    assert.equal(candidates[0].path, 'a.md', 'a.md is aligned with the query, b.md is orthogonal');

    const similar = await store.vectors.similar('a.md', { exclude: new Set(), k: 10 });
    assert.deepEqual(
      similar.map((r) => r.path),
      ['b.md']
    );
    await store.close();
  });
});
