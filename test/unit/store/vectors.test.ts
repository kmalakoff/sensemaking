import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { withMaterializedVectorScope } from '../../../src/commands/scope.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { createStore } from '../../../src/store/sqlite/store.ts';
import { writeVectorBatch } from '../../../src/store/sqlite/vectors.ts';
import type { Connection, Store } from '../../../src/store/types.ts';
import { asCosine, createNativeVectorScopeOwner, hasVectorRow, NATIVE_VECTOR_SCOPE_TABLE, pendingRows, reserveNativeVectorScope, sampleEvenly, TARGET_CHUNK_CAP } from '../../../src/store/vectors.ts';

// pendingRows/hasVectorRow are engine-neutral IS NULL/IS NOT NULL checks; sqlite's Connection is
// the lightest concrete one available (no optional native dependency), used only as a portable Connection, not to exercise sqlite-specific behavior.
function makeDb(): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
    return { db, conn: createConnection(db) };
  } catch (err) {
    db.close();
    throw err;
  }
}

async function withDb<T>(fn: (db: DatabaseSync, conn: Connection) => Promise<T>): Promise<T> {
  const { db, conn } = makeDb();
  try {
    return await fn(db, conn);
  } finally {
    db.close();
  }
}

function insertPending(db: DatabaseSync, path: string, chunk: number, start = 1, end = 1): void {
  db.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)').run(path, chunk, start, end);
}

function int8(values: number[]): Buffer {
  return Buffer.from(Int8Array.from(values).buffer);
}

function makeScopeStore(): { db: DatabaseSync; store: Store } {
  const db = new DatabaseSync(':memory:');
  try {
    const conn = createConnection(db);
    db.exec(`
      CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY);
      CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, content_identity TEXT NOT NULL, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk));
    `);
    return { db, store: createStore(db, conn) };
  } catch (err) {
    db.close();
    throw err;
  }
}

async function seedScopeStore(store: Store): Promise<void> {
  await store.runBatch('INSERT INTO frontmatter ("path") VALUES (?)', [['a.md'], ['b.md'], ['c.md'], ['d.md']]);
  await store.runBatch('INSERT INTO embeddings ("path", chunk, start_line, end_line, content_identity, scale, vector) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    ['a.md', 0, 1, 1, 'authored:a', 1, int8([127, 0])],
    ['b.md', 0, 1, 1, 'authored:b', 1, int8([0, 127])],
    ['c.md', 0, 1, 1, 'authored:c', 1, int8([-127, 0])],
    ['d.md', 0, 1, 1, 'authored:d', 1, int8([0, -127])],
  ]);
}

async function tempScopeExists(store: Store): Promise<boolean> {
  const stmt = await store.prepare(`SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = ?`);
  return (await stmt.get(NATIVE_VECTOR_SCOPE_TABLE)) !== undefined;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  let failed = false;
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    failed = true;
    error = err;
  }
  assert.equal(failed, true, 'expected promise to reject');
  return error;
}

describe('pendingRows', () => {
  it('returns only rows whose vector is NULL, ordered by path then chunk', async () => {
    await withDb(async (db, conn) => {
      insertPending(db, 'b.md', 1);
      insertPending(db, 'a.md', 0);
      insertPending(db, 'a.md', 1);
      await writeVectorBatch(conn, [{ path: 'a.md', chunk: 0, scale: 1, vector: int8([1]) }]);

      assert.deepEqual(await pendingRows(conn), [
        { path: 'a.md', chunk: 1 },
        { path: 'b.md', chunk: 1 },
      ]);
    });
  });
});

describe('hasVectorRow', () => {
  it('distinguishes no rows, rows still pending, and at least one embedded chunk', async () => {
    await withDb(async (db, conn) => {
      assert.equal(await hasVectorRow(conn, 'missing.md'), false);

      insertPending(db, 'pending.md', 0);
      assert.equal(await hasVectorRow(conn, 'pending.md'), false);

      insertPending(db, 'partial.md', 0);
      insertPending(db, 'partial.md', 1);
      await writeVectorBatch(conn, [{ path: 'partial.md', chunk: 1, scale: 1, vector: int8([1]) }]);
      assert.equal(await hasVectorRow(conn, 'partial.md'), true);
    });
  });
});

describe('sampleEvenly', () => {
  it('keeps every row when under the cap', () => {
    assert.deepEqual(sampleEvenly([1, 2, 3], 16), [1, 2, 3]);
  });

  it('samples evenly at a fixed step when over the cap, always keeping the first row', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(sampleEvenly(rows, 16), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });

  it('defaults to TARGET_CHUNK_CAP', () => {
    const rows = Array.from({ length: 20 }, (_, i) => i);
    assert.deepEqual(sampleEvenly(rows), sampleEvenly(rows, TARGET_CHUNK_CAP));
  });
});

describe('asCosine', () => {
  it('rounds to three decimal places', () => {
    assert.equal(asCosine(0.123456), 0.123);
  });

  it('clamps a dequantized score that lands slightly outside [-1, 1]', () => {
    assert.equal(asCosine(1.0006), 1);
    assert.equal(asCosine(-1.0006), -1);
  });
});

describe('native vector scope ownership', () => {
  it('keeps the temp table inside the caller transaction and bypasses empty, unscoped, and broad sets', async () => {
    const { db, store } = makeScopeStore();
    try {
      await seedScopeStore(store);
      await store.transaction(async () => {
        await (await store.prepare('SELECT COUNT(*) AS count FROM frontmatter')).get();
        await withMaterializedVectorScope(store, new Set(['a.md']), async () => {
          assert.equal(await tempScopeExists(store), true);
          const rows = (await (await store.prepare(`SELECT "path" FROM ${NATIVE_VECTOR_SCOPE_TABLE} ORDER BY "path"`)).all()) as Array<{ path: string }>;
          assert.deepEqual(rows, [{ path: 'a.md' }]);
        });
        assert.equal(await tempScopeExists(store), false, 'scope cleanup must finish before the caller transaction resumes');
      });

      await withMaterializedVectorScope(store, new Set(['a.md', 'b.md']), async () => {
        assert.equal(await tempScopeExists(store), true, 'an allowed set equal to its complement remains eligible');
      });

      for (const allowed of [new Set(['a.md', 'b.md', 'c.md']), new Set(['a.md', 'b.md', 'c.md', 'd.md'])]) {
        await withMaterializedVectorScope(store, allowed, async () => {
          assert.equal(await tempScopeExists(store), false);
        });
      }

      await store.exec('DROP TABLE frontmatter');
      await withMaterializedVectorScope(store, new Set(), async () => {
        assert.equal(await tempScopeExists(store), false, 'empty scope bypasses before the fallback count');
      });
      await withMaterializedVectorScope(
        store,
        new Set(['a.md']),
        async () => {
          assert.equal(await tempScopeExists(store), true, 'a known snapshot count avoids the fallback query');
        },
        4
      );
    } finally {
      db.close();
    }
  });

  it('binds activation to one Store, rejects reentry, and invalidates released reservations', async () => {
    const first = makeScopeStore();
    const second = makeScopeStore();
    try {
      await seedScopeStore(first.store);
      await seedScopeStore(second.store);
      const replacement = createNativeVectorScopeOwner();
      assert.throws(() => replacement.bind(first.store.vectors), /already bound/);
      const shared = new Set(['a.md']);
      await withMaterializedVectorScope(first.store, shared, async () => {
        await assert.rejects(() => withMaterializedVectorScope(first.store, shared, async () => undefined), /already active/);
        assert.deepEqual(
          (await first.store.vectors.candidates(new Float32Array([1, 0]), 2, 10, shared)).map((row) => row.path),
          ['a.md']
        );
        assert.deepEqual(
          (await second.store.vectors.candidates(new Float32Array([1, 0]), 2, 10, shared)).map((row) => row.path),
          ['a.md'],
          'the same Set cannot activate another Store without its own reservation and temp table'
        );
      });

      assert.deepEqual(
        (await first.store.vectors.candidates(new Float32Array([1, 0]), 2, 10, shared)).map((row) => row.path),
        ['a.md'],
        'a direct call after release retains the JS filter fallback'
      );
      const released = reserveNativeVectorScope(first.store.vectors, shared);
      assert.ok(released);
      released.activate();
      released.deactivate();
      released.invalidate();
      assert.throws(() => released.activate(), /no longer valid/);
      const fresh = reserveNativeVectorScope(first.store.vectors, shared);
      assert.ok(fresh, 'release must permit a later operation');
      fresh.invalidate();
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  it('preserves callback failures including null and exposes real materialization and cleanup failures', async () => {
    const { db, store } = makeScopeStore();
    const allowed = new Set(['a.md']);
    try {
      await seedScopeStore(store);

      const callbackError = await rejectionOf(
        withMaterializedVectorScope(store, allowed, async () => {
          throw null;
        })
      );
      assert.equal(callbackError, null);
      assert.equal(await tempScopeExists(store), false);

      await store.exec(`CREATE TEMP VIEW ${NATIVE_VECTOR_SCOPE_TABLE} AS SELECT 'a.md' AS "path"`);
      let called = false;
      const materializeError = await rejectionOf(
        withMaterializedVectorScope(store, allowed, async () => {
          called = true;
        })
      );
      assert.equal(called, false);
      assert.ok(materializeError instanceof AggregateError);
      assert.equal(materializeError.errors.length, 2, 'materialization and cleanup failures must both remain visible');
      await store.exec(`DROP VIEW ${NATIVE_VECTOR_SCOPE_TABLE}`);

      const cleanupError = await rejectionOf(
        withMaterializedVectorScope(store, allowed, async () => {
          await store.exec(`DROP TABLE ${NATIVE_VECTOR_SCOPE_TABLE}`);
          await store.exec(`CREATE TEMP VIEW ${NATIVE_VECTOR_SCOPE_TABLE} AS SELECT 'a.md' AS "path"`);
        })
      );
      assert.ok(cleanupError instanceof Error);
      await store.exec(`DROP VIEW ${NATIVE_VECTOR_SCOPE_TABLE}`);

      const combined = await rejectionOf(
        withMaterializedVectorScope(store, allowed, async () => {
          await store.exec(`DROP TABLE ${NATIVE_VECTOR_SCOPE_TABLE}`);
          await store.exec(`CREATE TEMP VIEW ${NATIVE_VECTOR_SCOPE_TABLE} AS SELECT 'a.md' AS "path"`);
          throw null;
        })
      );
      assert.ok(combined instanceof AggregateError);
      assert.equal(combined.errors[0], null);
      assert.ok(combined.errors[1] instanceof Error);
      await store.exec(`DROP VIEW ${NATIVE_VECTOR_SCOPE_TABLE}`);

      await withMaterializedVectorScope(store, allowed, async () => {
        assert.equal(await tempScopeExists(store), true);
      });
      assert.equal(await tempScopeExists(store), false, 'every failure path must release the owner for later use');
    } finally {
      db.close();
    }
  });
});
