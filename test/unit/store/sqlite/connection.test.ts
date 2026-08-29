import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from '../../../../src/store/sqlite/connection.ts';
import { withTransaction } from '../../../../src/store/transaction.ts';

describe('createConnection (sqlite)', () => {
  it('exec/prepare/run/get/all satisfy the portable async Connection/Statement contract', async () => {
    const db = new DatabaseSync(':memory:');
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
    } finally {
      db.close();
    }
  });

  it('columns() and iterate() work the same as the sync driver, just async', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      await insert.run(1);
      await insert.run(2);

      const stmt = await conn.prepare('SELECT a FROM t ORDER BY a');
      assert.deepEqual(
        stmt.columns().map((c) => c.name),
        ['a']
      );
      const seen: unknown[] = [];
      for await (const row of stmt.iterate()) seen.push(row);
      assert.deepEqual(seen, [{ a: 1 }, { a: 2 }]);
    } finally {
      db.close();
    }
  });

  describe('runBatch', () => {
    it('prepares once and writes every row', async () => {
      const db = new DatabaseSync(':memory:');
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
        db.close();
      }
    });

    it('an empty paramRows array is a no-op', async () => {
      const db = new DatabaseSync(':memory:');
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await conn.runBatch('INSERT INTO t VALUES (?)', []);
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        db.close();
      }
    });

    it('rolls back every row in the batch if one fails', async () => {
      const db = new DatabaseSync(':memory:');
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
        await assert.rejects(
          conn.runBatch(
            'INSERT INTO t (a) VALUES (?)',
            [1, 2, 2].map((n) => [n])
          )
        );
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        db.close();
      }
    });

    it('joins an enclosing transaction rather than opening a second one', async () => {
      const db = new DatabaseSync(':memory:');
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER)');
        await assert.rejects(
          withTransaction(conn, async () => {
            await conn.runBatch('INSERT INTO t VALUES (?)', [[1], [2]]);
            throw new Error('fail after the batch');
          }),
          /fail after the batch/
        );
        // The outer transaction's rollback undoes the batch's writes too: runBatch joined it
        // rather than committing its own.
        const all = await (await conn.prepare('SELECT a FROM t')).all();
        assert.deepEqual(all, []);
      } finally {
        db.close();
      }
    });
  });
});
