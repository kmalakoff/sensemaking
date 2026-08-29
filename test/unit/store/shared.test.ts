import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { getColumns, getMeta, quoteIdent, setMeta } from '../../../src/store/shared.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';

// Engine-neutral: both stores' Connection satisfies the same exec/prepare/runBatch shape, so
// one sqlite-backed connection is enough to exercise this module (a duckdb-backed run of the
// same assertions belongs in test/integration/store-parity.test.ts, not duplicated here).

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
});
