import type { Database } from '@tursodatabase/database';
import { connect } from '@tursodatabase/database';
import assert from 'assert';
import { toStore } from '../../../../src/embed/query.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from '../../../../src/store/turso/vectors.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { assertSeparatedScores, quantizeVector, separatedVectorFixture, VECTOR_DIMS } from '../../../lib/vectors.ts';

const DIMS = VECTOR_DIMS;

async function makeConn(dims = DIMS): Promise<{ db: Database; conn: Connection }> {
  const db = await connect(':memory:');
  try {
    const conn = createConnection(db);
    await conn.exec(`CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector F32_BLOB(${dims}), PRIMARY KEY ("path", chunk))`);
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
  const stmt = await conn.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)');
  await stmt.run(path, chunk, start, end);
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

  it('an empty allowed set matches nothing, same as sqlite', async () => {
    await withDb(async (conn) => {
      await insertPending(conn, 'a.md', 0);
      await writeVectorBatch(conn, DIMS, [{ path: 'a.md', chunk: 0, ...quantizeVector(full(1, 0)) }]);
      assert.deepEqual(await scanCandidates(conn, full(1, 0), DIMS, 10, new Set()), []);
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

      const result = await scanSimilar(conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
      assert.equal(result.length, 1);
      assert.equal(result[0].path, 'other.md');
      assert.equal(result[0].similarity, 0, 'the unsampled chunk (index 1) must not lift the score off orthogonal');
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
