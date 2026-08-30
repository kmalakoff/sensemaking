import assert from 'node:assert';
import type { SenseError } from '../../../../src/errors.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function tursoTree(baseDir: string) {
  return openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('createStore (turso)', () => {
  it('declares its name and an empty capability set (portable surface only, phase 1)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await tursoTree(baseDir);
    assert.equal(store.name, 'turso');
    assert.deepEqual(new Set(store.capabilities), new Set());
    await store.close();
  });

  it('docs.columns() returns frontmatter column names, including dynamic keys', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const { store } = await tursoTree(baseDir);
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
    const { store } = await tursoTree(baseDir);
    const stmt = await store.raw.prepare('SELECT "path" FROM frontmatter ORDER BY "path"');
    const rows: unknown[] = [];
    for await (const row of stmt.iterate()) rows.push(row);
    assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }]);
    await store.close();
  });

  it('raw.prepare() reads int64 values past 2^53 as BigInt', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await tursoTree(baseDir);
    const stmt = await store.raw.prepare('SELECT 9007199254740993 AS big');
    const rows: Array<{ big: unknown }> = [];
    for await (const row of stmt.iterate()) rows.push(row as { big: unknown });
    assert.equal(typeof rows[0].big, 'bigint');
    assert.equal(rows[0].big, BigInt('9007199254740993'));
    await store.close();
  });

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

  describe('capability gaps (phase 1: no lexical, no vectors)', () => {
    it('lexical.query() throws STORE_CAPABILITY_MISSING naming "lexical"', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
      const { store } = await tursoTree(baseDir);
      await assert.rejects(
        () => store.lexical.query('word', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 }),
        (err: SenseError) => {
          assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
          assert.match(err.message, /store "turso" does not implement "lexical"/);
          return true;
        }
      );
      await store.close();
    });

    it('vectors.candidates()/similar()/writeVectors() throw STORE_CAPABILITY_MISSING naming "vectors"', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
      const { store } = await tursoTree(baseDir);
      const calls: Array<() => Promise<unknown>> = [() => store.vectors.candidates(new Float32Array(4), 4, 10), () => store.vectors.similar('a.md', { exclude: new Set(), k: 10 }), () => store.vectors.writeVectors([])];
      for (const call of calls) {
        await assert.rejects(call, (err: SenseError) => {
          assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
          assert.match(err.message, /store "turso" does not implement "vectors"/);
          return true;
        });
      }
      await store.close();
    });
  });
});
