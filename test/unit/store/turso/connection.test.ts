import assert from 'node:assert';
import { connect, type Database } from '@tursodatabase/database';
import { withTransaction } from '../../../../src/store/transaction.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';

function openConn(): Promise<Database> {
  return connect(':memory:', {});
}

describe('createConnection (turso)', () => {
  it('exec/prepare/run/get/all satisfy the portable Connection/Statement contract', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER, b TEXT)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?, ?)');
      await insert.run(1, 'x');
      await insert.run(2, 'y');

      const all = await (await conn.prepare('SELECT * FROM t ORDER BY a')).all();
      assert.deepEqual(all, [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ]);

      const one = await (await conn.prepare('SELECT * FROM t WHERE a = ?')).get(1);
      assert.deepEqual(one, { a: 1, b: 'x' });

      const missing = await (await conn.prepare('SELECT * FROM t WHERE a = ?')).get(99);
      assert.equal(missing, undefined);
    } finally {
      await db.close();
    }
  });

  it('a prepared statement can be reused across several run() calls', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      for (let i = 0; i < 3; i++) await insert.run(i);
      const row = (await (await conn.prepare('SELECT COUNT(*) AS n FROM t')).get()) as { n: number };
      assert.equal(row.n, 3);
    } finally {
      await db.close();
    }
  });

  it('columns() reports the statement shape', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER, b TEXT)');
      const stmt = await conn.prepare('SELECT a, b FROM t');
      assert.deepEqual(
        stmt.columns().map((c) => c.name),
        ['a', 'b']
      );
    } finally {
      await db.close();
    }
  });

  it('setReadBigInts(true) round-trips an int64 past 2^53 as BigInt', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      const stmt = await conn.prepare('SELECT 9007199254740993 AS big');
      stmt.setReadBigInts(true);
      const row = (await stmt.get()) as { big: unknown };
      assert.equal(typeof row.big, 'bigint');
      assert.equal(row.big, BigInt('9007199254740993'));
    } finally {
      await db.close();
    }
  });

  it('setReadBigInts(false), the default, loses precision past 2^53', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      const stmt = await conn.prepare('SELECT 9007199254740993 AS big');
      const row = (await stmt.get()) as { big: unknown };
      assert.equal(typeof row.big, 'number');
      assert.equal(row.big, 9007199254740992, 'lossy: the true int64 9007199254740993 rounds down to the nearest representable double');
    } finally {
      await db.close();
    }
  });

  it('iterate() yields the same rows as all()', async () => {
    const db = await openConn();
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      await insert.run(1);
      await insert.run(2);
      const seen: unknown[] = [];
      for await (const row of (await conn.prepare('SELECT a FROM t ORDER BY a')).iterate()) seen.push(row);
      assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
    } finally {
      await db.close();
    }
  });

  describe('runBatch', () => {
    it('writes every row in one call', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
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
        await db.close();
      }
    });

    it('several runBatch calls inside one withTransaction scope share a single BEGIN/COMMIT (join, not savepoint)', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await withTransaction(conn, async () => {
          await conn.runBatch('INSERT INTO t VALUES (?)', [[1], [2]]);
          await conn.runBatch('INSERT INTO t VALUES (?)', [[3]]);
        });
        const all = await (await conn.prepare('SELECT a FROM t ORDER BY a')).all();
        assert.deepEqual(all, [{ a: 1 }, { a: 2 }, { a: 3 }]);
      } finally {
        await db.close();
      }
    });

    it('an error inside an enclosing withTransaction scope rolls back every runBatch call made within it', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await assert.rejects(
          withTransaction(conn, async () => {
            await conn.runBatch('INSERT INTO t VALUES (?)', [[1], [2]]);
            throw new Error('boom');
          })
        );
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        await db.close();
      }
    });

    it('called standalone, opens and commits/rolls back its own transaction (atomic even without an outer scope)', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
        await conn.runBatch('INSERT INTO t VALUES (?)', [[1]]);
        // row 1 is a duplicate PK: the whole call must roll back, not just the failing row.
        await assert.rejects(() => conn.runBatch('INSERT INTO t VALUES (?)', [[2], [1], [3]]));
        const all = await (await conn.prepare('SELECT a FROM t ORDER BY a')).all();
        assert.deepEqual(all, [{ a: 1 }]);
      } finally {
        await db.close();
      }
    });

    it('an empty paramRows array is a no-op', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await conn.runBatch('INSERT INTO t VALUES (?)', []);
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        await db.close();
      }
    });
  });
});
