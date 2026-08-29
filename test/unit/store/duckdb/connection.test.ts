import assert from 'node:assert';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import { createConnection } from '../../../../src/store/duckdb/connection.ts';

async function openConn(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(':memory:');
  return instance.connect();
}

describe('createConnection (duckdb)', () => {
  it('exec/prepare/run/get/all satisfy the portable Connection/Statement contract', async () => {
    const duckdb = await openConn();
    try {
      const conn = createConnection(duckdb);
      await conn.exec('CREATE TABLE t (a INTEGER, b TEXT)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?, ?)');
      await insert.run(BigInt(1), 'x');
      await insert.run(BigInt(2), 'y');

      const all = await (await conn.prepare('SELECT * FROM t ORDER BY a')).all();
      assert.deepEqual(all, [
        { a: BigInt(1), b: 'x' },
        { a: BigInt(2), b: 'y' },
      ]);

      const one = await (await conn.prepare('SELECT * FROM t WHERE a = ?')).get(BigInt(1));
      assert.deepEqual(one, { a: BigInt(1), b: 'x' });

      const missing = await (await conn.prepare('SELECT * FROM t WHERE a = ?')).get(BigInt(99));
      assert.equal(missing, undefined);
    } finally {
      duckdb.disconnectSync();
    }
  });

  it('a prepared statement can be reused across several run() calls', async () => {
    const duckdb = await openConn();
    try {
      const conn = createConnection(duckdb);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      for (let i = 0; i < 3; i++) await insert.run(BigInt(i));
      const rows = (await (await conn.prepare('SELECT COUNT(*) AS n FROM t')).get()) as { n: bigint };
      assert.equal(rows.n, BigInt(3));
    } finally {
      duckdb.disconnectSync();
    }
  });

  it('columns() reports the statement shape', async () => {
    const duckdb = await openConn();
    try {
      const conn = createConnection(duckdb);
      await conn.exec('CREATE TABLE t (a INTEGER, b TEXT)');
      const stmt = await conn.prepare('SELECT a, b FROM t');
      assert.deepEqual(
        stmt.columns().map((c) => c.name),
        ['a', 'b']
      );
    } finally {
      duckdb.disconnectSync();
    }
  });

  it('setReadBigInts is a documented no-op: big values already arrive as BigInt', async () => {
    const duckdb = await openConn();
    try {
      const conn = createConnection(duckdb);
      const stmt = await conn.prepare('SELECT 9007199254740993 AS big');
      stmt.setReadBigInts(true);
      const row = (await stmt.get()) as { big: unknown };
      assert.equal(typeof row.big, 'bigint');
      assert.equal(row.big, BigInt('9007199254740993'));
    } finally {
      duckdb.disconnectSync();
    }
  });

  it('iterate() yields the same rows as all()', async () => {
    const duckdb = await openConn();
    try {
      const conn = createConnection(duckdb);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      await insert.run(BigInt(1));
      await insert.run(BigInt(2));
      const seen: unknown[] = [];
      for await (const row of (await conn.prepare('SELECT a FROM t ORDER BY a')).iterate()) seen.push(row);
      assert.deepEqual(seen, [{ a: BigInt(1) }, { a: BigInt(2) }]);
    } finally {
      duckdb.disconnectSync();
    }
  });

  describe('runBatch', () => {
    it('rewrites a single-row INSERT into one multi-row statement', async () => {
      const duckdb = await openConn();
      try {
        const conn = createConnection(duckdb);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await conn.runBatch('INSERT INTO t (a, b) VALUES (?, ?)', [
          [1, 'x'],
          [2, 'y'],
          [3, 'z'],
        ]);
        const all = await (await conn.prepare('SELECT * FROM t ORDER BY a')).all();
        assert.deepEqual(all, [
          { a: 1, b: 'x' },
          { a: 2, b: 'y' },
          { a: 3, b: 'z' },
        ]);
      } finally {
        duckdb.disconnectSync();
      }
    });

    it('rewrites a single-column DELETE ... WHERE = ? into one IN-list statement', async () => {
      const duckdb = await openConn();
      try {
        const conn = createConnection(duckdb);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
        await conn.runBatch(
          'INSERT INTO t (a) VALUES (?)',
          [1, 2, 3, 4].map((n) => [n])
        );
        await conn.runBatch(
          'DELETE FROM t WHERE a = ?',
          [2, 4].map((n) => [n])
        );
        const all = await (await conn.prepare('SELECT a FROM t ORDER BY a')).all();
        assert.deepEqual(all, [{ a: 1 }, { a: 3 }]);
      } finally {
        duckdb.disconnectSync();
      }
    });

    it('rewrites a single-column-SET UPDATE ... WHERE = ? into one VALUES-joined statement', async () => {
      const duckdb = await openConn();
      try {
        const conn = createConnection(duckdb);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await conn.runBatch(
          'INSERT INTO t (a, b) VALUES (?, ?)',
          [1, 2].map((n) => [n, 'old'])
        );
        await conn.runBatch('UPDATE t SET b = ? WHERE a = ?', [
          ['new1', 1],
          ['new2', 2],
        ]);
        const all = await (await conn.prepare('SELECT * FROM t ORDER BY a')).all();
        assert.deepEqual(all, [
          { a: 1, b: 'new1' },
          { a: 2, b: 'new2' },
        ]);
      } finally {
        duckdb.disconnectSync();
      }
    });

    it('falls back to a per-row loop for a shape it does not recognize, still one call from the caller', async () => {
      const duckdb = await openConn();
      try {
        const conn = createConnection(duckdb);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        // Not a shape rewriteBatch handles (no WHERE clause at all): exercises the fallback path.
        await conn.runBatch('INSERT INTO t SELECT ?', [[1], [2], [3]]);
        const all = await (await conn.prepare('SELECT a FROM t ORDER BY a')).all();
        assert.deepEqual(all, [{ a: 1 }, { a: 2 }, { a: 3 }]);
      } finally {
        duckdb.disconnectSync();
      }
    });

    it('an empty paramRows array is a no-op', async () => {
      const duckdb = await openConn();
      try {
        const conn = createConnection(duckdb);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await conn.runBatch('INSERT INTO t VALUES (?)', []);
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        duckdb.disconnectSync();
      }
    });
  });
});
