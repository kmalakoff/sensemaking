import assert from 'node:assert';
import { DuckDBInstance } from '@duckdb/node-api';
import { toStore } from '../../../../src/embed/query.ts';
import { createConnection } from '../../../../src/store/duckdb/connection.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from '../../../../src/store/duckdb/vectors.ts';
import type { Connection } from '../../../../src/store/types.ts';

const DIMS = 8;

async function makeDb(dims = DIMS) {
  const instance = await DuckDBInstance.create(':memory:');
  const duckdb = await instance.connect();
  const conn = createConnection(duckdb);
  await conn.exec(`CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector FLOAT[${dims}], PRIMARY KEY ("path", chunk))`);
  return { duckdb, conn };
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

// Quantizes exactly as embedPending does (src/embed/query.ts): every store is handed the same
// int8+scale wire format and dequantizes it into its own representation (see writeVectorBatch).
function quantize(vector: Float32Array, dims = DIMS): { scale: number; vector: Buffer } {
  const { v, scale } = toStore(vector, dims, true);
  const q = new Int8Array(dims);
  for (let d = 0; d < dims; d++) q[d] = Math.round(v[d] / scale);
  return { scale, vector: Buffer.from(q.buffer) };
}

describe('int8 quantization round trip (duckdb)', () => {
  it('a vector stored then scored against its own query form ranks near cosine 1', async () => {
    const { duckdb, conn } = await makeDb();
    const source = full(3, -1, 4, 1, -5, 9, 2, -6);
    const { v: qv } = toStore(source, DIMS, false);
    const { scale, vector } = quantize(source);
    await insertPending(conn, 'a.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [{ path: 'a.md', chunk: 0, scale, vector }]);

    const [top] = await scanCandidates(duckdb, qv, DIMS, 5);
    assert.equal(top.path, 'a.md');
    assert.ok(top.similarity > 0.99, `expected near-1 cosine for an identical vector, got ${top.similarity}`);
  });

  // Unlike sqlite's raw dot-product score, array_cosine_similarity divides by each vector's own
  // norm, so per-vector scale cancels out of ranking here (it still matters for magnitude, not order); sqlite's scale-weighted-score case has no duckdb equivalent.
});

describe('scanCandidates (duckdb)', () => {
  it('orders results by descending cosine similarity', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'high.md', 0);
    await insertPending(conn, 'mid.md', 0);
    await insertPending(conn, 'low.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'high.md', chunk: 0, ...quantize(full(1, 0)) }, // cosine 1 with the query
      { path: 'mid.md', chunk: 0, ...quantize(full(1, 1)) }, // cosine ~0.707
      { path: 'low.md', chunk: 0, ...quantize(full(0, 1)) }, // cosine 0 (orthogonal)
    ]);
    const result = await scanCandidates(duckdb, full(1, 0), DIMS, 10);
    assert.deepEqual(
      result.map((r) => r.path),
      ['high.md', 'mid.md', 'low.md']
    );
  });

  it('keeps only the best-scoring chunk per path (dedup by path)', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'a.md', 0, 1, 5);
    await insertPending(conn, 'a.md', 1, 6, 10);
    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'a.md', chunk: 0, ...quantize(full(0, 1)) }, // orthogonal to the query
      { path: 'a.md', chunk: 1, ...quantize(full(1, 0)) }, // aligned with the query
    ]);
    const result = await scanCandidates(duckdb, full(1, 0), DIMS, 10);
    assert.equal(result.length, 1, 'one path should appear once, deduped to its best chunk');
    assert.equal(result[0].lines, 'L6-10', 'the higher-scoring chunk (1) should win, not the first inserted');
  });

  it('narrows candidates to the allowed set', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'a.md', 0);
    await insertPending(conn, 'b.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'a.md', chunk: 0, ...quantize(full(1, 0)) },
      { path: 'b.md', chunk: 0, ...quantize(full(1, 0)) },
    ]);
    const result = await scanCandidates(duckdb, full(1, 0), DIMS, 10, new Set(['b.md']));
    assert.deepEqual(
      result.map((r) => r.path),
      ['b.md']
    );
  });

  it('an empty allowed set matches nothing, same as sqlite', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'a.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [{ path: 'a.md', chunk: 0, ...quantize(full(1, 0)) }]);
    assert.deepEqual(await scanCandidates(duckdb, full(1, 0), DIMS, 10, new Set()), []);
  });
});

describe('scanSimilar (duckdb)', () => {
  it('ranks by max chunk-pair cosine and never returns the target path itself', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'target.md', 0);
    await insertPending(conn, 'near.md', 0);
    await insertPending(conn, 'far.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'target.md', chunk: 0, ...quantize(full(1, 0)) },
      { path: 'near.md', chunk: 0, ...quantize(full(1, 1)) }, // ~0.707 with target
      { path: 'far.md', chunk: 0, ...quantize(full(0, 1)) }, // 0 with target (orthogonal)
    ]);
    const result = await scanSimilar(duckdb, conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
    assert.deepEqual(
      result.map((r) => r.path),
      ['near.md', 'far.md']
    );
  });

  it('honors the exclude and allowed filters', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'target.md', 0);
    await insertPending(conn, 'a.md', 0);
    await insertPending(conn, 'b.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'target.md', chunk: 0, ...quantize(full(1, 0)) },
      { path: 'a.md', chunk: 0, ...quantize(full(1, 0)) },
      { path: 'b.md', chunk: 0, ...quantize(full(1, 0)) },
    ]);

    const excluded = await scanSimilar(duckdb, conn, DIMS, 'target.md', { exclude: new Set(['a.md']), k: 10 });
    assert.deepEqual(
      excluded.map((r) => r.path),
      ['b.md']
    );

    const allowed = await scanSimilar(duckdb, conn, DIMS, 'target.md', { exclude: new Set(), allowed: new Set(['b.md']), k: 10 });
    assert.deepEqual(
      allowed.map((r) => r.path),
      ['b.md']
    );

    const emptyAllowed = await scanSimilar(duckdb, conn, DIMS, 'target.md', { exclude: new Set(), allowed: new Set(), k: 10 });
    assert.deepEqual(emptyAllowed, [], 'an empty allowed set matches nothing, same as sqlite');
  });

  it('returns [] when the target note has no embedded chunks', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'no-vectors.md', 0); // vector stays NULL
    await insertPending(conn, 'other.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, [{ path: 'other.md', chunk: 0, ...quantize(full(1, 0)) }]);
    assert.deepEqual(await scanSimilar(duckdb, conn, DIMS, 'no-vectors.md', { exclude: new Set(), k: 10 }), []);
  });

  it('samples seed chunks under TARGET_CHUNK_CAP: an unsampled chunk cannot skew the score', async () => {
    const { duckdb, conn } = await makeDb();
    // TARGET_CHUNK_CAP is 16; 20 target chunks -> step = ceil(20/16) = 2, sampling even indices
    // (0, 2, 4, ..., 18). Index 1 is odd and therefore never sampled.
    const chunkCount = 20;
    for (let i = 0; i < chunkCount; i++) await insertPending(conn, 'target.md', i);
    await insertPending(conn, 'other.md', 0);

    // other.md and every sampled target chunk are orthogonal (cosine 0); only the unsampled trap
    // chunk (index 1) matches other.md's direction (cosine 1) -- broken sampling would jump the score to 1.
    const rows: Array<{ path: string; chunk: number; scale: number; vector: Buffer }> = [];
    for (let i = 0; i < chunkCount; i++) rows.push({ path: 'target.md', chunk: i, ...quantize(i === 1 ? full(0, 1) : full(1, 0)) });
    rows.push({ path: 'other.md', chunk: 0, ...quantize(full(0, 1)) });
    await writeVectorBatch(duckdb, conn, DIMS, rows);

    const result = await scanSimilar(duckdb, conn, DIMS, 'target.md', { exclude: new Set(), k: 10 });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'other.md');
    assert.equal(result[0].similarity, 0, 'the unsampled chunk (index 1) must not lift the score off orthogonal');
  });
});

describe('writeVectorBatch (duckdb)', () => {
  it('writes vectors for exactly the targeted (path, chunk) rows, leaving others pending', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'a.md', 0);
    await insertPending(conn, 'a.md', 1);
    await insertPending(conn, 'b.md', 0);

    await writeVectorBatch(duckdb, conn, DIMS, [
      { path: 'a.md', chunk: 0, scale: 0.5, vector: Buffer.from(Int8Array.from([42, 0, 0, 0, 0, 0, 0, 0]).buffer) },
      { path: 'b.md', chunk: 0, scale: 0.25, vector: Buffer.from(Int8Array.from([-7, 0, 0, 0, 0, 0, 0, 0]).buffer) },
    ]);

    const pendingStmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk');
    assert.deepEqual(await pendingStmt.all(), [{ path: 'a.md', chunk: 1 }]);

    const row = (await (await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND chunk = ?')).get('a.md', 0)) as { vector: number[] };
    assert.equal(row.vector[0], 21, 'dequantized: int8 42 * scale 0.5');
  });

  it('does nothing for an empty batch', async () => {
    const { duckdb, conn } = await makeDb();
    await insertPending(conn, 'a.md', 0);
    await writeVectorBatch(duckdb, conn, DIMS, []);
    const pendingStmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL');
    assert.deepEqual(await pendingStmt.all(), [{ path: 'a.md', chunk: 0 }]);
  });
});
