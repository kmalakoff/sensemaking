import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getColumns, getMeta, quoteIdent, setMeta } from '../../../src/store/shared.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// Engine-neutral: both stores' Connection satisfies the same exec/prepare/runBatch shape, so a
// sqlite-backed connection suffices; a duckdb-backed run belongs in test/integration/store-parity.test.ts.

describe('quoteIdent', () => {
  it('doubles an embedded double quote', () => {
    assert.equal(quoteIdent('a"b'), '"a""b"');
  });
});

describe('getColumns / getMeta / setMeta', () => {
  it('getColumns reads frontmatter column names via PRAGMA table_info', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const conn = createConnection(db);
      await conn.exec(`CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL)`);
      await conn.exec(`ALTER TABLE frontmatter ADD COLUMN "title"`);
      const columns = await getColumns(conn);
      assert.ok(columns.has('path'));
      assert.ok(columns.has('_mtime'));
      assert.ok(columns.has('title'));
    } finally {
      db.close();
    }
  });

  it('setMeta upserts, getMeta reads back, and null deletes', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      assert.equal(await getMeta(conn, 'k'), null);
      await setMeta(conn, 'k', 'v1');
      assert.equal(await getMeta(conn, 'k'), 'v1');
      await setMeta(conn, 'k', 'v2');
      assert.equal(await getMeta(conn, 'k'), 'v2');
      await setMeta(conn, 'k', null);
      assert.equal(await getMeta(conn, 'k'), null);
    } finally {
      db.close();
    }
  });

  // Row counts, not just the read-back value: an upsert that inserted a second row and a null
  // that stored NULL both pass the assertions above.
  it('an upsert leaves one row, and a null value deletes the row rather than storing NULL', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
      const rows = async () => ((await (await conn.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?')).get('k')) as { n: number }).n;
      await setMeta(conn, 'k', 'first');
      await setMeta(conn, 'k', 'second');
      assert.equal(await rows(), 1);
      await setMeta(conn, 'k', null);
      assert.equal(await rows(), 0);
    } finally {
      db.close();
    }
  });

  // A Store satisfies Connection structurally, which is why these took a Connection and the
  // former store/meta.ts duplicate took a Store. External callers pass a Store.
  it('accepts a Store, not only a raw Connection', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    assert.equal(await getMeta(store, 'nope'), null);
    await setMeta(store, 'custom', 'hello');
    assert.equal(await getMeta(store, 'custom'), 'hello');
    await store.close();
  });
});
