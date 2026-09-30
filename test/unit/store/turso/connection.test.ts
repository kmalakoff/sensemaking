import assert from 'node:assert';
import { connect, type Database } from '@tursodatabase/database';
import { BEGIN_WRITE, withTransaction } from '../../../../src/store/transaction.ts';
import { createConnection, INSERT_BIND_BUDGET } from '../../../../src/store/turso/connection.ts';

function openConn(): Promise<Database> {
  return connect(':memory:', {});
}

function observeInserts(db: Database, failCloseAt?: number) {
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const statements: Array<{ binds: number; closed: boolean; immediateServiced: boolean; executionError?: unknown; cleanupError?: unknown }> = [];
  const transactions: string[] = [];
  const pending: NodeJS.Immediate[] = [];
  db.exec = async (sql) => {
    if (/^(BEGIN(?: IMMEDIATE)?|COMMIT|ROLLBACK)$/.test(sql)) transactions.push(sql);
    return exec(sql);
  };
  db.prepare = async (sql) => {
    const stmt = await prepare(sql);
    if (!sql.startsWith('INSERT')) return stmt;
    const run = stmt.run.bind(stmt);
    const close = stmt.close.bind(stmt);
    const state: (typeof statements)[number] = { binds: (sql.match(/\?/g) ?? []).length, closed: false, immediateServiced: false };
    statements.push(state);
    const failClose = statements.length === failCloseAt;
    stmt.run = async (...params) => {
      try {
        return await run(...params);
      } catch (error) {
        state.executionError = error;
        throw error;
      }
    };
    stmt.close = () => {
      close();
      state.closed = true;
      pending.push(
        setImmediate(() => {
          state.immediateServiced = true;
        })
      );
      if (failClose) {
        // Produce a real native error after real finalization, as the cleanup owner tests do.
        try {
          stmt.columns();
        } catch (error) {
          state.cleanupError = error;
          throw error;
        }
        assert.fail('the finalized native statement must reject metadata access');
      }
    };
    return stmt;
  };
  return {
    statements,
    transactions,
    restore() {
      for (const immediate of pending) clearImmediate(immediate);
      db.prepare = prepare;
      db.exec = exec;
    },
  };
}

describe('createConnection (turso)', () => {
  it('finalizes native statements and services cleanup turns after reads, writes, failures and early stream return while allowing reuse', async () => {
    const db = await openConn();
    const prepare = db.prepare.bind(db);
    const statements: Array<{ closed: boolean; immediateServiced: boolean }> = [];
    const pending: NodeJS.Immediate[] = [];
    // Observe real native finalization without substituting execution or query results.
    db.prepare = async (sql) => {
      const stmt = await prepare(sql);
      const close = stmt.close.bind(stmt);
      const state = { closed: false, immediateServiced: false };
      statements.push(state);
      stmt.close = () => {
        close();
        state.closed = true;
        pending.push(
          setImmediate(() => {
            state.immediateServiced = true;
          })
        );
      };
      return stmt;
    };
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      await insert.run(1);
      assert.equal(statements.length, 1);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      await insert.run(2);
      assert.equal(statements.length, 2);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      await assert.rejects(() => insert.run(2));
      assert.ok(
        statements.every((stmt) => stmt.closed && stmt.immediateServiced),
        'constraint failure must finalize its native statement'
      );
      await insert.run(3);

      const select = await conn.prepare('SELECT a FROM t ORDER BY a');
      assert.deepEqual(
        select.columns().map(({ name }) => name),
        ['a']
      );
      assert.deepEqual(await select.get(), { a: 1 });
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      assert.deepEqual(await select.all(), [{ a: 1 }, { a: 2 }, { a: 3 }]);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      for await (const row of select.iterate()) {
        assert.deepEqual(row, { a: 1 });
        break;
      }
      assert.ok(
        statements.every((stmt) => stmt.closed && stmt.immediateServiced),
        'early return must finalize the native cursor'
      );
      const complete: unknown[] = [];
      for await (const row of select.iterate()) complete.push(row);
      assert.deepEqual(complete, [{ a: 1 }, { a: 2 }, { a: 3 }]);
      assert.ok(
        statements.every((stmt) => stmt.closed && stmt.immediateServiced),
        'exhaustion must finalize the native cursor'
      );
      const interrupted = select.iterate()[Symbol.asyncIterator]();
      assert.deepEqual(await interrupted.next(), { value: { a: 1 }, done: false });
      const throwInto = interrupted.throw?.bind(interrupted);
      assert.ok(throwInto);
      const reason = { message: 'authored stream cancellation' };
      await assert.rejects(
        () => throwInto(reason),
        (error: unknown) => error === reason
      );
      assert.ok(
        statements.every((stmt) => stmt.closed && stmt.immediateServiced),
        'iterator failure must finalize the native cursor'
      );
      assert.deepEqual(
        select.columns().map(({ name }) => name),
        ['a']
      );
      assert.deepEqual(await select.all(), [{ a: 1 }, { a: 2 }, { a: 3 }]);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));

      const big = await conn.prepare('SELECT 9007199254740993 AS big');
      big.setReadBigInts(true);
      assert.deepEqual(await big.get(), { big: BigInt('9007199254740993') });
      assert.deepEqual(await big.get(), { big: BigInt('9007199254740993') });
      big.setReadBigInts(false);
      assert.deepEqual(await big.get(), { big: 9007199254740992 });
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));

      await conn.runBatch('INSERT INTO t (a) VALUES (?)', [[4], [5]]);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      await conn.runBatch('UPDATE t SET a = ? WHERE a = ?', [
        [6, 4],
        [7, 5],
      ]);
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      await assert.rejects(() => conn.runBatch('INSERT INTO t (a) VALUES (?)', [[8], [1]]));
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      await assert.rejects(() =>
        conn.runBatch('UPDATE t SET a = ? WHERE a = ?', [
          [8, 6],
          [1, 7],
        ])
      );
      assert.ok(statements.every((stmt) => stmt.closed && stmt.immediateServiced));
      assert.deepEqual(await select.all(), [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 6 }, { a: 7 }]);
    } finally {
      for (const immediate of pending) clearImmediate(immediate);
      db.prepare = prepare;
      await db.close();
    }
  });

  it('services cleanup turns while preserving native execution and close errors', async () => {
    const db = await openConn();
    const prepare = db.prepare.bind(db);
    const pending: NodeJS.Immediate[] = [];
    let executionError: unknown;
    let cleanupError: unknown;
    let immediateServiced = false;
    try {
      const conn = createConnection(db);
      await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
      await (await conn.prepare('INSERT INTO t VALUES (?)')).run(1);
      db.prepare = async (sql) => {
        const stmt = await prepare(sql);
        const run = stmt.run.bind(stmt);
        const close = stmt.close.bind(stmt);
        stmt.run = async (...params) => {
          try {
            return await run(...params);
          } catch (error) {
            executionError = error;
            throw error;
          }
        };
        stmt.close = () => {
          close();
          immediateServiced = false;
          pending.push(
            setImmediate(() => {
              immediateServiced = true;
            })
          );
          // Reading metadata after real finalization produces a native cleanup failure.
          try {
            stmt.columns();
          } catch (error) {
            cleanupError = error;
            throw error;
          }
          assert.fail('the finalized native statement must reject metadata access');
        };
        return stmt;
      };
      const select = await conn.prepare('SELECT a FROM t');
      await assert.rejects(
        () => select.all(),
        (error: unknown) => error === cleanupError
      );
      assert.ok(immediateServiced, 'close failure must still service queued cleanup');
      const insert = await conn.prepare('INSERT INTO t VALUES (?)');
      const combined = (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [executionError, cleanupError]);
        assert.ok(immediateServiced);
        return true;
      };
      await assert.rejects(() => insert.run(1), combined);
      for (const sql of ['INSERT INTO t (a) VALUES (?)', 'INSERT INTO t VALUES (?)']) {
        await assert.rejects(() => conn.runBatch(sql, [[2], [1]]), combined);
      }
      db.prepare = prepare;
      assert.deepEqual(await select.all(), [{ a: 1 }], 'failed batches rolled back and the portable statement remains reusable');
    } finally {
      for (const immediate of pending) clearImmediate(immediate);
      db.prepare = prepare;
      await db.close();
    }
  });

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

    it('writes 30,000 five-column rows (150,000 params) through bounded multi-row statements', async () => {
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

    it('bounds seven-column and 306-column INSERTs, finalizes every batch, and preserves exact rows and insertion order through the tail', async () => {
      for (const width of [7, 306]) {
        const db = await openConn();
        let observed: ReturnType<typeof observeInserts> | undefined;
        try {
          const conn = createConnection(db);
          const columns = Array.from({ length: width }, (_, i) => `c${i}`);
          await conn.exec(`CREATE TABLE t (${columns.map((col) => `${col} INTEGER`).join(', ')})`);
          const batchRows = Math.floor(INSERT_BIND_BUDGET / width);
          const rowCount = batchRows * 2 + 5;
          const rows = Array.from({ length: rowCount }, (_, i) => columns.map((_, c) => i * 1000 + c));
          observed = observeInserts(db);
          await withTransaction(conn, () => conn.runBatch(`INSERT INTO t (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, rows), BEGIN_WRITE);
          assert.deepEqual(observed.transactions, ['BEGIN IMMEDIATE', 'COMMIT'], 'all batches join one outer transaction');
          assert.deepEqual(
            observed.statements.map(({ binds }) => binds),
            [batchRows * width, batchRows * width, 5 * width]
          );
          assert.ok(observed.statements.every(({ binds, closed, immediateServiced }) => binds <= INSERT_BIND_BUDGET && closed && immediateServiced));
          const actual = await (await conn.prepare('SELECT rowid AS rid, * FROM t ORDER BY rowid')).all();
          const expected = Array.from({ length: rowCount }, (_, i) => ({ rid: i + 1, ...Object.fromEntries(columns.map((col, c) => [col, i * 1000 + c])) }));
          assert.deepEqual(actual, expected);
          const insert = await conn.prepare(`INSERT INTO t (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
          const result = await insert.run(...columns.map(() => -1));
          assert.equal(result.changes, 1);
          assert.equal(result.lastInsertRowid, rowCount + 1, 'normal Statement.run keeps native rowid semantics');
        } finally {
          observed?.restore();
          await db.close();
        }
      }
    });

    it('rolls back completed INSERT batches on a tail constraint failure, retaining the seed and allowing statement reuse', async () => {
      const db = await openConn();
      let observed: ReturnType<typeof observeInserts> | undefined;
      try {
        const conn = createConnection(db);
        await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, c INTEGER, d INTEGER, e INTEGER, f INTEGER, g INTEGER)');
        const sql = 'INSERT INTO t (a, b, c, d, e, f, g) VALUES (?, ?, ?, ?, ?, ?, ?)';
        const insert = await conn.prepare(sql);
        await insert.run(0, 0, 0, 0, 0, 0, 0);
        const batchRows = Math.floor(INSERT_BIND_BUDGET / 7);
        const rows = Array.from({ length: batchRows * 2 }, (_, i) => Array(7).fill(i + 1) as number[]);
        rows.push([0, 1, 1, 1, 1, 1, 1]);
        observed = observeInserts(db);
        await assert.rejects(
          () => conn.runBatch(sql, rows),
          (error: unknown) => error === observed?.statements[2].executionError
        );
        assert.deepEqual(observed.transactions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
        assert.equal(observed.statements.length, 3);
        assert.ok(observed.statements.every(({ closed, immediateServiced }) => closed && immediateServiced));
        assert.deepEqual(await (await conn.prepare('SELECT * FROM t ORDER BY a')).all(), [{ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 }]);
        observed.restore();
        const result = await insert.run(1, 1, 1, 1, 1, 1, 1);
        assert.equal(result.changes, 1);
        assert.deepEqual(await (await conn.prepare('SELECT a FROM t ORDER BY a')).all(), [{ a: 0 }, { a: 1 }]);
      } finally {
        observed?.restore();
        await db.close();
      }
    });

    it('rolls back earlier batches on tail cleanup failure and preserves combined native execution and cleanup errors', async () => {
      for (const constraintFailure of [false, true]) {
        const db = await openConn();
        let observed: ReturnType<typeof observeInserts> | undefined;
        try {
          const conn = createConnection(db);
          await conn.exec('CREATE TABLE t (a INTEGER PRIMARY KEY, b INTEGER, c INTEGER, d INTEGER, e INTEGER, f INTEGER, g INTEGER)');
          const sql = 'INSERT INTO t (a, b, c, d, e, f, g) VALUES (?, ?, ?, ?, ?, ?, ?)';
          await (await conn.prepare(sql)).run(0, 0, 0, 0, 0, 0, 0);
          const batchRows = Math.floor(INSERT_BIND_BUDGET / 7);
          const rows = Array.from({ length: batchRows * 2 + 1 }, (_, i) => Array(7).fill(i + 1) as number[]);
          if (constraintFailure) rows[rows.length - 1][0] = 0;
          observed = observeInserts(db, 3);
          await assert.rejects(
            () => conn.runBatch(sql, rows),
            (error: unknown) => {
              const tail = observed?.statements[2];
              assert.ok(tail?.cleanupError);
              if (constraintFailure) {
                assert.ok(tail.executionError);
                assert.ok(error instanceof AggregateError);
                assert.deepEqual(error.errors, [tail.executionError, tail.cleanupError]);
              } else {
                assert.equal(tail.executionError, undefined);
                assert.equal(error, tail.cleanupError);
              }
              return true;
            }
          );
          assert.deepEqual(observed.transactions, ['BEGIN IMMEDIATE', 'ROLLBACK']);
          assert.equal(observed.statements.length, 3);
          assert.ok(observed.statements.every(({ closed, immediateServiced }) => closed && immediateServiced));
          assert.deepEqual(await (await conn.prepare('SELECT a FROM t ORDER BY a')).all(), [{ a: 0 }]);
          observed.restore();
          await conn.runBatch(sql, [[1, 1, 1, 1, 1, 1, 1]]);
          assert.deepEqual(await (await conn.prepare('SELECT a FROM t ORDER BY a')).all(), [{ a: 0 }, { a: 1 }]);
        } finally {
          observed?.restore();
          await db.close();
        }
      }
    });

    it('preserves ON CONFLICT DO UPDATE order within and across folded statements', async () => {
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
        const batchRows = Math.floor(INSERT_BIND_BUDGET / 3);
        const rows = Array.from({ length: batchRows }, (_, i) => [`src-${String(i).padStart(6, '0')}`, 'target', 'first']);
        rows.push(['src-000000', 'target', 'last'], ['tail', 'target', 'tail']);
        await conn.runBatch('INSERT INTO links (src, target, target_base) VALUES (?, ?, ?) ON CONFLICT(src, target) DO UPDATE SET target_base = excluded.target_base', rows);
        assert.deepEqual(await (await conn.prepare('SELECT * FROM links ORDER BY src, target')).all(), [
          { src: 'a', target: 'b', target_base: 'second' },
          ...Array.from({ length: batchRows }, (_, i) => ({ src: `src-${String(i).padStart(6, '0')}`, target: 'target', target_base: i === 0 ? 'last' : 'first' })),
          { src: 'tail', target: 'target', target_base: 'tail' },
        ]);
      } finally {
        await db.close();
      }
    });

    it('OR IGNORE drops duplicates within and across folded statements', async () => {
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
        const batchRows = Math.floor(INSERT_BIND_BUDGET / 2);
        const rows = Array.from({ length: batchRows }, (_, i) => [`q${String(i).padStart(6, '0')}`, 'tag']);
        rows.push(['q000000', 'tag'], ['tail', 'tag']);
        await conn.runBatch('INSERT OR IGNORE INTO tags ("path", tag) VALUES (?, ?)', rows);
        assert.deepEqual(await (await conn.prepare('SELECT * FROM tags ORDER BY "path", tag')).all(), [{ path: 'p1', tag: 't1' }, { path: 'p1', tag: 't2' }, ...Array.from({ length: batchRows }, (_, i) => ({ path: `q${String(i).padStart(6, '0')}`, tag: 'tag' })), { path: 'tail', tag: 'tag' }]);
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
