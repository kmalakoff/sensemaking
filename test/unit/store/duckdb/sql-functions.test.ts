import assert from 'node:assert';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import { registerFunctions } from '../../../../src/store/duckdb/sql-functions.ts';
import { segmentMatch } from '../../../../src/text/segment.ts';

async function openConn(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await registerFunctions(conn);
  return conn;
}

async function scalar<T>(conn: DuckDBConnection, sql: string): Promise<T> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS()[0][reader.columnName(0)] as T;
}

describe('registerFunctions (duckdb)', () => {
  it('has() matches JSON-array and plain-string fields the same as the shared implementation', async () => {
    const conn = await openConn();
    try {
      assert.equal(await scalar(conn, `SELECT has('["a","b"]', 'a')`), 1);
      assert.equal(await scalar(conn, `SELECT has('hello world', 'world')`), 1);
      assert.equal(await scalar(conn, `SELECT has('hello world', 'xyz')`), 0);
    } finally {
      conn.disconnectSync();
    }
  });

  it('basename() strips a suffix like the shared implementation', async () => {
    const conn = await openConn();
    try {
      assert.equal(await scalar(conn, `SELECT basename('notes/a.md')`), 'a.md');
      assert.equal(await scalar(conn, `SELECT basename('notes/a.md', '.md')`), 'a');
    } finally {
      conn.disconnectSync();
    }
  });

  // Principle 6: segment() is registered against the real src/text/segment.ts implementation,
  // not a passthrough -- an unspaced-script run comes back rewritten into its grapheme phrase,
  // not returned unchanged.
  it('segment() runs the real grapheme-phrase rewrite, not an identity passthrough', async () => {
    const conn = await openConn();
    try {
      const text = '东京都';
      const got = await scalar<string>(conn, `SELECT segment('${text}')`);
      assert.equal(got, segmentMatch(text));
      assert.notEqual(got, text);
    } finally {
      conn.disconnectSync();
    }
  });
});
