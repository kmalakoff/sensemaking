import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { withTransaction } from '../../../src/store/transaction.ts';
import type { Connection } from '../../../src/store/types.ts';

function makeConn(): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (v TEXT)');
  return { db, conn: createConnection(db) };
}

function rows(db: DatabaseSync): string[] {
  return (db.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: string }>).map((r) => r.v);
}

describe('withTransaction', () => {
  it('commits a non-nested scope', async () => {
    const { db, conn } = makeConn();
    await withTransaction(conn, async () => {
      db.exec(`INSERT INTO t VALUES ('a')`);
    });
    assert.deepEqual(rows(db), ['a']);
  });

  it('rolls back a non-nested scope on throw', async () => {
    const { db, conn } = makeConn();
    await assert.rejects(
      () =>
        withTransaction(conn, async () => {
          db.exec(`INSERT INTO t VALUES ('a')`);
          throw new Error('boom');
        }),
      /boom/
    );
    assert.deepEqual(rows(db), []);
  });

  it('a nested scope joins the outer transaction instead of issuing its own BEGIN', async () => {
    const { db, conn } = makeConn();
    await withTransaction(conn, async () => {
      db.exec(`INSERT INTO t VALUES ('a')`);
      // A second BEGIN on this connection would throw; reaching here proves the inner
      // call joined rather than starting its own transaction.
      await withTransaction(conn, async () => {
        db.exec(`INSERT INTO t VALUES ('b')`);
      });
    });
    assert.deepEqual(rows(db), ['a', 'b']);
  });

  it('an inner failure swallowed by an outer catch still rolls back and surfaces an error', async () => {
    const { db, conn } = makeConn();
    await assert.rejects(
      () =>
        withTransaction(conn, async () => {
          db.exec(`INSERT INTO t VALUES ('a')`);
          try {
            await withTransaction(conn, async () => {
              throw new Error('inner boom');
            });
          } catch {
            // swallowed: the outer scope has no idea the inner one failed
          }
        }),
      /rolled back/
    );
    assert.deepEqual(rows(db), []);
  });

  it('two connections do not share depth state', async () => {
    const a = makeConn();
    const b = makeConn();
    await withTransaction(a.conn, async () => {
      a.db.exec(`INSERT INTO t VALUES ('a')`);
      // While a's transaction is open, b must still get its own real BEGIN -- if depth
      // were shared, this would be (wrongly) treated as nested and issue no BEGIN of its own,
      // leaving b's insert auto-committed instead of rolled back below.
      await assert.rejects(
        () =>
          withTransaction(b.conn, async () => {
            b.db.exec(`INSERT INTO t VALUES ('b')`);
            throw new Error('boom');
          }),
        /boom/
      );
      assert.deepEqual(rows(b.db), []);
    });
    assert.deepEqual(rows(a.db), ['a']);
  });
});
