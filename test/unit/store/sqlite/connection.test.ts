import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from '../../../../src/store/sqlite/connection.ts';

describe('createConnection (sqlite)', () => {
  it('SQLite numeric bindings and reads preserve native number rows', async () => {
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

  it('SQLite iterate() preserves native number rows', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      await insert.run(1);
      await insert.run(2);

      const stmt = await conn.prepare('SELECT a FROM t ORDER BY a');
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
  });
});
