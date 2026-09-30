import type { Database } from '@tursodatabase/database';
import { connect } from '@tursodatabase/database';
import assert from 'assert';
import { withMaterializedVectorScope } from '../../../../src/commands/scope.ts';
import { toStore } from '../../../../src/embed/query.ts';
import { STORE_DIMS } from '../../../../src/embed/types.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';
import { createStore } from '../../../../src/store/turso/store.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from '../../../../src/store/turso/vectors.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { NATIVE_VECTOR_SCOPE_TABLE } from '../../../../src/store/vectors.ts';
import { assertSeparatedScores, cosineOracle, quantizeVector, separatedVectorFixture, VECTOR_DIMS } from '../../../lib/vectors.ts';

const DIMS = VECTOR_DIMS;

async function makeConn(dims = DIMS): Promise<{ db: Database; conn: Connection }> {
  const db = await connect(':memory:');
  try {
    const conn = createConnection(db);
    await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY)');
    await conn.exec(`CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, content_identity TEXT NOT NULL, scale REAL, vector F32_BLOB(${dims}), PRIMARY KEY ("path", chunk))`);
    return { db, conn };
  } catch (err) {
    await db.close();
    throw err;
  }
}

async function withDb<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const { db, conn } = await makeConn();
  try {
    return await fn(conn);
  } finally {
    await db.close();
  }
}

async function insertPending(conn: Connection, path: string, chunk: number, start = 1, end = 1): Promise<void> {
  const stmt = await conn.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, content_identity, scale, vector) VALUES (?, ?, ?, ?, ?, NULL, NULL)');
  await stmt.run(path, chunk, start, end, `authored:${path}:${chunk}`);
}

// A DIMS-wide vector with the given values at the leading dimensions, zero elsewhere -- lets
// each test spell out only the components it cares about.
function full(...values: number[]): Float32Array {
  const v = new Float32Array(DIMS);
  values.forEach((val, i) => {
    v[i] = val;
  });
  return v;
}

async function materializeNativeScope(conn: Connection, paths: Set<string>): Promise<void> {
  await conn.exec(`CREATE TEMP TABLE ${NATIVE_VECTOR_SCOPE_TABLE} ("path" TEXT PRIMARY KEY)`);
  await conn.runBatch(
    `INSERT INTO ${NATIVE_VECTOR_SCOPE_TABLE} ("path") VALUES (?)`,
    [...paths].map((path) => [path])
  );
}

describe('int8 quantization round trip (turso)', () => {
  it('a vector stored then scored against its own query form ranks near cosine 1', async () => {
    await withDb(async (conn) => {
      const source = full(3, -1, 4, 1, -5, 9, 2, -6);
      const { v: qv } = toStore(source, DIMS, false);
      const { scale, vector } = quantizeVector(source);
      await insertPending(conn, 'a.md', 0);
      await writeVectorBatch(conn, DIMS, [{ path: 'a.md', chunk: 0, scale, vector }]);

      const [top] = await scanCandidates(conn, qv, DIMS, 5);
      assert.equal(top.path, 'a.md');
      assert.ok(top.similarity > 0.99, `expected near-1 cosine for an identical vector, got ${top.similarity}`);
    });
  });
});

describe('scanCandidates (turso)', () => {
  it('orders separated mixed-direction vectors by descending cosine similarity', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      const rows = [
        ['exact.md', fixture.exact],
        ['diagonal.md', fixture.diagonal],
        ['orthogonal.md', fixture.orthogonal],
        ['anti.md', fixture.antiParallel],
      ] as const;
      for (const [path] of rows) await insertPending(conn, path, 0);
      await writeVectorBatch(
        conn,
        DIMS,
        rows.map(([path, vector]) => ({ path, chunk: 0, ...quantizeVector(vector) }))
      );
      const result = await scanCandidates(conn, fixture.query, DIMS, 10);
      assert.deepEqual(
        result.map((r) => r.path),
        ['exact.md', 'diagonal.md', 'orthogonal.md', 'anti.md']
      );
      assertSeparatedScores(result);
      assert.ok(result[0].similarity > result[1].similarity);
      assert.ok(result[1].similarity > result[2].similarity);
      assert.ok(result[2].similarity > result[3].similarity);
    });
  });

  it('keeps only the best-scoring chunk per path (dedup by path)', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      await insertPending(conn, 'a.md', 0, 1, 5);
      await insertPending(conn, 'a.md', 1, 6, 10);
      await writeVectorBatch(conn, DIMS, [
        { path: 'a.md', chunk: 0, ...quantizeVector(fixture.orthogonal) },
        { path: 'a.md', chunk: 1, ...quantizeVector(fixture.exact) },
      ]);
      const result = await scanCandidates(conn, fixture.query, DIMS, 10);
      assert.equal(result.length, 1, 'one path should appear once, deduped to its best chunk');
      assert.equal(result[0].lines, 'L6-10', 'the higher-scoring chunk (1) should win, not the first inserted');
    });
  });

  it('narrows candidates to the allowed set', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      await insertPending(conn, 'a.md', 0);
      await insertPending(conn, 'b.md', 0);
      await writeVectorBatch(conn, DIMS, [
        { path: 'a.md', chunk: 0, ...quantizeVector(fixture.exact) },
        { path: 'b.md', chunk: 0, ...quantizeVector(fixture.diagonal) },
      ]);
      const result = await scanCandidates(conn, fixture.query, DIMS, 10, new Set(['b.md']));
      assert.deepEqual(
        result.map((r) => r.path),
        ['b.md']
      );
    });
  });

  it('uses the Store-bound native scope inside the caller transaction for escaped candidate and similar rows', async () => {
    const { db, conn } = await makeConn(STORE_DIMS);
    const store = createStore(db, conn, { observational: true });
    try {
      const productionVector = (...values: number[]): Float32Array => {
        const vector = new Float32Array(STORE_DIMS);
        values.forEach((value, index) => {
          vector[index] = value;
        });
        return vector;
      };
      const allowed = new Set(['quote"note.md', 'back\\slash.md', 'café/文.md']);
      const rows = [
        ['target.md', productionVector(1, 0)],
        ['quote"note.md', productionVector(1, 0)],
        ['back\\slash.md', productionVector(1, 0)],
        ['café/文.md', productionVector(0, 1)],
        ['outside.md', productionVector(-1, 0)],
        ['another.md', productionVector(0, -1)],
      ] as const;
      await store.runBatch(
        'INSERT INTO frontmatter ("path") VALUES (?)',
        rows.map(([path]) => [path])
      );
      for (const [path] of rows) await insertPending(conn, path, 0);
      await store.vectors.writeVectors(rows.map(([path, vector]) => ({ path, chunk: 0, ...quantizeVector(vector, STORE_DIMS) })));

      await store.transaction(async () => {
        await (await store.prepare('SELECT "path" FROM frontmatter ORDER BY "path" LIMIT 1')).get();
        await withMaterializedVectorScope(store, allowed, async () => {
          const scopeRows = (await (await store.prepare(`SELECT "path" FROM ${NATIVE_VECTOR_SCOPE_TABLE} ORDER BY "path"`)).all()) as Array<{ path: string }>;
          assert.deepEqual(scopeRows, [{ path: 'back\\slash.md' }, { path: 'café/文.md' }, { path: 'quote"note.md' }]);
          assert.deepEqual(
            (await store.vectors.candidates(productionVector(1, 0), STORE_DIMS, 10, allowed)).map((row) => row.path),
            ['back\\slash.md', 'quote"note.md', 'café/文.md']
          );
          assert.deepEqual(
            (await store.vectors.similar('target.md', { exclude: new Set(), allowed, k: 10 })).map((row) => row.path),
            ['back\\slash.md', 'quote"note.md', 'café/文.md']
          );
        });
        const released = await (await store.prepare(`SELECT name FROM sqlite_temp_master WHERE type = 'table' AND name = ?`)).get(NATIVE_VECTOR_SCOPE_TABLE);
        assert.equal(released, undefined, 'scope cleanup must finish before the caller transaction resumes');
      });
    } finally {
      await store.close();
    }
  });

  it('an empty allowed set matches nothing, same as sqlite', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'a.md', 0);
      await writeVectorBatch(conn, DIMS, [{ path: 'a.md', chunk: 0, ...quantizeVector(full(1, 0)) }]);
      assert.deepEqual(await scanCandidates(conn, full(1, 0), DIMS, 10, new Set()), []);
    });
  });

  it('returns finite neutral scores when either vector has zero norm', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'zero.md', 0);
      await insertPending(conn, 'exact.md', 0);
      await writeVectorBatch(conn, DIMS, [
        { path: 'zero.md', chunk: 0, ...quantizeVector(full(0, 0)) },
        { path: 'exact.md', chunk: 0, ...quantizeVector(full(1, 0)) },
      ]);

      const storedZero = await scanCandidates(conn, full(1, 0), DIMS, 10);
      assert.deepEqual(
        storedZero.map((r) => [r.path, r.similarity]),
        [
          ['exact.md', 1],
          ['zero.md', 0],
        ]
      );

      const queryZero = await scanCandidates(conn, full(0, 0), DIMS, 10);
      assert.deepEqual(
        queryZero.map((r) => [r.path, r.similarity]),
        [
          ['exact.md', 0],
          ['zero.md', 0],
        ]
      );
    });
  });

  it('orders distinct raw cosines before applying public score rounding', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'z-near.md', 0);
      await insertPending(conn, 'a-near.md', 0);
      await writeVectorBatch(conn, DIMS, [
        { path: 'z-near.md', chunk: 0, ...quantizeVector(full(127, 1)) },
        { path: 'a-near.md', chunk: 0, ...quantizeVector(full(127, 2)) },
      ]);
      const query = full(1, 0);
      const expected = [cosineOracle([127, 1], query), cosineOracle([127, 2], query)];
      assert.ok(expected[0] > expected[1]);
      assert.equal(Math.round(expected[0] * 1000) / 1000, 1);
      assert.equal(Math.round(expected[1] * 1000) / 1000, 1);

      const result = await scanCandidates(conn, query, DIMS, 2);
      assert.deepEqual(
        result.map((r) => r.path),
        ['z-near.md', 'a-near.md']
      );
      assert.deepEqual(
        result.map((r) => r.similarity),
        [1, 1]
      );
    });
  });
});

describe('scanSimilar (turso)', () => {
  it('ranks by max chunk-pair cosine and never returns the target path itself', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      const rows = [
        ['target.md', fixture.exact],
        ['near.md', fixture.diagonal],
        ['far.md', fixture.orthogonal],
        ['anti.md', fixture.antiParallel],
      ] as const;
      for (const [path] of rows) await insertPending(conn, path, 0);
      await writeVectorBatch(
        conn,
        DIMS,
        rows.map(([path, vector]) => ({ path, chunk: 0, ...quantizeVector(vector) }))
      );
      const result = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
      assert.deepEqual(
        result.map((r) => r.path),
        ['near.md', 'far.md', 'anti.md']
      );
      assert.ok(result[0].similarity > result[1].similarity);
      assert.ok(result[1].similarity > result[2].similarity);
    });
  });

  it('honors the exclude and allowed filters', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      const exact = quantizeVector(fixture.exact);
      await insertPending(conn, 'target.md', 0);
      await insertPending(conn, 'a.md', 0);
      await insertPending(conn, 'b.md', 0);
      await writeVectorBatch(conn, DIMS, [
        { path: 'target.md', chunk: 0, ...exact },
        { path: 'a.md', chunk: 0, ...exact },
        { path: 'b.md', chunk: 0, ...exact },
      ]);

      const excluded = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(['a.md']), k: 10 });
      assert.deepEqual(
        excluded.map((r) => r.path),
        ['b.md']
      );

      const allowed = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), allowed: new Set(['b.md']), k: 10 });
      assert.deepEqual(
        allowed.map((r) => r.path),
        ['b.md']
      );

      const emptyAllowed = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), allowed: new Set(), k: 10 });
      assert.deepEqual(emptyAllowed, [], 'an empty allowed set matches nothing, same as sqlite');
    });
  });

  it('returns [] when the target note has no embedded chunks', async () => {
    await withDb(async (conn) => {
      const fixture = separatedVectorFixture();
      await insertPending(conn, 'no-vectors.md', 0); // vector stays NULL
      await insertPending(conn, 'other.md', 0);
      await writeVectorBatch(conn, DIMS, [{ path: 'other.md', chunk: 0, ...quantizeVector(fixture.exact) }]);
      assert.deepEqual(await scanSimilar(conn, DIMS, 'no-vectors.md', { exclude: new Set(), k: 10 }), []);
    });
  });

  it('uses a neutral score for a zero target and orders exact ties by path', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'target.md', 0);
      await insertPending(conn, 'z.md', 0);
      await insertPending(conn, 'a.md', 0);
      await writeVectorBatch(conn, DIMS, [
        { path: 'target.md', chunk: 0, ...quantizeVector(full(0, 0)) },
        { path: 'z.md', chunk: 0, ...quantizeVector(full(1, 0)) },
        { path: 'a.md', chunk: 0, ...quantizeVector(full(0, 1)) },
      ]);

      const result = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
      assert.deepEqual(
        result.map((r) => [r.path, r.similarity]),
        [
          ['a.md', 0],
          ['z.md', 0],
        ]
      );
    });
  });

  it('samples seed chunks under TARGET_CHUNK_CAP: an unsampled chunk cannot skew the score', async () => {
    await withDb(async (conn) => {
      // TARGET_CHUNK_CAP is 16; 20 target chunks -> step = ceil(20/16) = 2, sampling even indices
      // (0, 2, 4, ..., 18). Index 1 is odd and therefore never sampled.
      const chunkCount = 20;
      for (let i = 0; i < chunkCount; i++) await insertPending(conn, 'target.md', i);
      await insertPending(conn, 'other.md', 0);

      // other.md points along dim 1; every sampled target chunk points along dim 0 (orthogonal,
      // cosine 0). Only the unsampled trap chunk (index 1) points along dim 1 (cosine 1) -- if sampling were broken, the result would jump from 0 to 1.
      const rows: Array<{ path: string; chunk: number; scale: number; vector: Buffer }> = [];
      for (let i = 0; i < chunkCount; i++) rows.push({ path: 'target.md', chunk: i, ...quantizeVector(i === 1 ? full(0, 1) : full(1, 0)) });
      rows.push({ path: 'other.md', chunk: 0, ...quantizeVector(full(0, 1)) });
      await writeVectorBatch(conn, DIMS, rows);

      const unscoped = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
      assert.equal(unscoped.length, 1);
      assert.equal(unscoped[0].path, 'other.md');
      assert.equal(unscoped[0].similarity, 0, 'the unsampled chunk must not affect the direct scan');

      const allowed = new Set(['other.md']);
      await materializeNativeScope(conn, allowed);
      try {
        const result = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), allowed, k: 10 }, true);
        assert.equal(result.length, 1);
        assert.equal(result[0].path, 'other.md');
        assert.equal(result[0].similarity, 0, 'the unsampled chunk (index 1) must not lift the score off orthogonal');
      } finally {
        await conn.exec(`DROP TABLE ${NATIVE_VECTOR_SCOPE_TABLE}`);
      }
    });
  });
});

describe('writeVectorBatch (turso)', () => {
  it('writes vectors for exactly the targeted (path, chunk) rows, leaving others pending', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'a.md', 0);
      await insertPending(conn, 'a.md', 1);
      await insertPending(conn, 'b.md', 0);

      await writeVectorBatch(conn, DIMS, [
        { path: 'a.md', chunk: 0, scale: 0.5, vector: Buffer.from(Int8Array.from([42, 0, 0, 0, 0, 0, 0, 0]).buffer) },
        { path: 'b.md', chunk: 0, scale: 0.25, vector: Buffer.from(Int8Array.from([-7, 0, 0, 0, 0, 0, 0, 0]).buffer) },
      ]);

      const pendingStmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk');
      assert.deepEqual(await pendingStmt.all(), [{ path: 'a.md', chunk: 1 }]);

      const row = (await (await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND chunk = ?')).get('a.md', 0)) as { vector: Buffer };
      const decoded = new Float32Array(row.vector.buffer, row.vector.byteOffset, DIMS);
      assert.equal(decoded[0], 21, 'dequantized: int8 42 * scale 0.5');
    });
  });

  it('does nothing for an empty batch', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'a.md', 0);
      await writeVectorBatch(conn, DIMS, []);
      const pendingStmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL');
      assert.deepEqual(await pendingStmt.all(), [{ path: 'a.md', chunk: 0 }]);
    });
  });
});
