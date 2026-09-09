import assert from 'node:assert';
import { connect, type Database } from '@tursodatabase/database';
import { withTransaction } from '../../../../src/store/transaction.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';

function openConn(): Promise<Database> {
  return connect(':memory:', {});
}

describe('createConnection (turso)', () => {
  it('Turso numeric bindings and reads preserve native number rows', async () => {
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

      const count = (await (await conn.prepare('SELECT COUNT(*) AS n FROM t')).get()) as { n: number };
      assert.equal(count.n, 2);
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

  it('Turso iterate() preserves native number rows', async () => {
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

    it('folds an INSERT into one multi-row VALUES statement instead of a per-row loop', async () => {
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

    it('folds 30,000 five-column rows (150,000 params) without the JS argument-spread limit a naive port would hit', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE wide (a INTEGER, b INTEGER, c INTEGER, d INTEGER, e INTEGER)');
        const rowCount = 30_000;
        const rows = Array.from({ length: rowCount }, (_, i) => [i, i, i, i, i]);
        await conn.runBatch('INSERT INTO wide (a, b, c, d, e) VALUES (?, ?, ?, ?, ?)', rows);
        const count = (await (await conn.prepare('SELECT COUNT(*) AS n FROM wide')).get()) as { n: number };
        assert.equal(count.n, rowCount);
        const last = await (await conn.prepare('SELECT * FROM wide WHERE a = ?')).get(rowCount - 1);
        assert.deepEqual(last, { a: rowCount - 1, b: rowCount - 1, c: rowCount - 1, d: rowCount - 1, e: rowCount - 1 });
      } finally {
        await db.close();
      }
    });

    it('resolves an ON CONFLICT DO UPDATE within one folded statement the same way sqlite would', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE links (src TEXT, target TEXT, target_base TEXT, PRIMARY KEY (src, target))');
        // Two rows collide on the PK within the same folded statement; the later row must win.
        await conn.runBatch('INSERT INTO links (src, target, target_base) VALUES (?, ?, ?) ON CONFLICT(src, target) DO UPDATE SET target_base = excluded.target_base', [
          ['a', 'b', 'first'],
          ['a', 'b', 'second'],
        ]);
        const all = await (await conn.prepare('SELECT * FROM links')).all();
        assert.deepEqual(all, [{ src: 'a', target: 'b', target_base: 'second' }]);
      } finally {
        await db.close();
      }
    });

    it('OR IGNORE drops an intra-batch duplicate within one folded statement', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE tags ("path" TEXT, tag TEXT, PRIMARY KEY ("path", tag))');
        await conn.runBatch('INSERT OR IGNORE INTO tags ("path", tag) VALUES (?, ?)', [
          ['p1', 't1'],
          ['p1', 't1'],
          ['p1', 't2'],
        ]);
        const all = await (await conn.prepare('SELECT * FROM tags ORDER BY tag')).all();
        assert.deepEqual(all, [
          { path: 'p1', tag: 't1' },
          { path: 'p1', tag: 't2' },
        ]);
      } finally {
        await db.close();
      }
    });

    it('an UPDATE does not fold: it keeps running one statement per row', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
        await conn.runBatch('INSERT INTO t (a, b) VALUES (?, ?)', [
          [1, 'x'],
          [2, 'y'],
        ]);
        await conn.runBatch('UPDATE t SET b = ? WHERE a = ?', [
          ['x2', 1],
          ['y2', 2],
        ]);
        const all = await (await conn.prepare('SELECT * FROM t ORDER BY a')).all();
        assert.deepEqual(all, [
          { a: 1, b: 'x2' },
          { a: 2, b: 'y2' },
        ]);
      } finally {
        await db.close();
      }
    });

    it('a folded multi-row INSERT still rolls back atomically on a later constraint violation', async () => {
      const db = await openConn();
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
        // A column list, not `INSERT INTO t VALUES (?)`: rewriteInsert only recognizes the
        // column-list shape, so this is what actually exercises the folded path, not the fallback.
        await conn.runBatch('INSERT INTO t (a) VALUES (?)', [[1]]);
        await assert.rejects(() => conn.runBatch('INSERT INTO t (a) VALUES (?)', [[2], [1], [3]]));
        const all = await (await conn.prepare('SELECT a FROM t ORDER BY a')).all();
        assert.deepEqual(all, [{ a: 1 }]);
      } finally {
        await db.close();
      }
    });
  });
});
