import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { toStore } from '../../../../src/embed/query.ts';
import { createConnection } from '../../../../src/store/sqlite/connection.ts';
import { hasVectorRow, pendingRows, scanCandidates, scanSimilar, writeVectorBatch } from '../../../../src/store/sqlite/vectors.ts';
import type { Connection } from '../../../../src/store/types.ts';

const DIMS = 8;

function makeDb(): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  return { db, conn: createConnection(db) };
}

function insertPending(db: DatabaseSync, path: string, chunk: number, start = 1, end = 1): void {
  db.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)').run(path, chunk, start, end);
}

function int8(values: number[]): Buffer {
  return Buffer.from(Int8Array.from(values).buffer);
}

// Quantizes exactly as embedPending does (src/embed/query.ts), so a stored row looks like real
// production output rather than a hand-rolled encoding.
function quantize(full: Float32Array, dims: number): { scale: number; vector: Buffer } {
  const { v, scale } = toStore(full, dims, true);
  const q = new Int8Array(dims);
  for (let d = 0; d < dims; d++) q[d] = Math.round(v[d] / scale);
  return { scale, vector: Buffer.from(q.buffer) };
}

describe('int8 quantization round trip', () => {
  it('a vector stored then scored against its own query form ranks near cosine 1', async () => {
    const { db, conn } = makeDb();
    const full = new Float32Array([3, -1, 4, 1, -5, 9, 2, -6]);
    const { v: qv } = toStore(full, DIMS, false); // query form: normalized f32, unquantized
    const { scale, vector } = quantize(full, DIMS);
    insertPending(db, 'a.md', 0);
    await writeVectorBatch(conn, [{ path: 'a.md', chunk: 0, scale, vector }]);

    const [top] = await scanCandidates(conn, qv, DIMS, 5);
    assert.equal(top.path, 'a.md');
    assert.ok(top.similarity > 0.99, `expected near-1 cosine for an identical vector, got ${top.similarity}`);
  });

  it('applies the stored per-vector scale rather than ignoring it', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'weak.md', 0);
    insertPending(db, 'strong.md', 0);
    // Same query direction; weak.md has the larger raw (unscaled) dot product but a scale
    // 10x smaller, so it must rank BELOW strong.md once scale is applied to the score.
    await writeVectorBatch(conn, [
      { path: 'weak.md', chunk: 0, scale: 0.1, vector: int8([100]) },
      { path: 'strong.md', chunk: 0, scale: 1.0, vector: int8([50]) },
    ]);
    const result = await scanCandidates(conn, new Float32Array([1]), 1, 2);
    assert.deepEqual(
      result.map((r) => r.path),
      ['strong.md', 'weak.md'],
      'scale must weight the score, not just the raw int8 dot product'
    );
  });
});

describe('scanCandidates', () => {
  it('orders results by descending cosine similarity', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'high.md', 0);
    insertPending(db, 'mid.md', 0);
    insertPending(db, 'low.md', 0);
    await writeVectorBatch(conn, [
      { path: 'high.md', chunk: 0, scale: 1, vector: int8([100]) },
      { path: 'mid.md', chunk: 0, scale: 1, vector: int8([50]) },
      { path: 'low.md', chunk: 0, scale: 1, vector: int8([10]) },
    ]);
    const result = await scanCandidates(conn, new Float32Array([1]), 1, 10);
    assert.deepEqual(
      result.map((r) => r.path),
      ['high.md', 'mid.md', 'low.md']
    );
  });

  it('keeps only the best-scoring chunk per path (dedup by path)', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'a.md', 0, 1, 5);
    insertPending(db, 'a.md', 1, 6, 10);
    await writeVectorBatch(conn, [
      { path: 'a.md', chunk: 0, scale: 1, vector: int8([10]) },
      { path: 'a.md', chunk: 1, scale: 1, vector: int8([100]) },
    ]);
    const result = await scanCandidates(conn, new Float32Array([1]), 1, 10);
    assert.equal(result.length, 1, 'one path should appear once, deduped to its best chunk');
    assert.equal(result[0].lines, 'L6-10', 'the higher-scoring chunk (1) should win, not the first inserted');
  });

  it('narrows candidates to the allowed set', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'a.md', 0);
    insertPending(db, 'b.md', 0);
    await writeVectorBatch(conn, [
      { path: 'a.md', chunk: 0, scale: 1, vector: int8([100]) },
      { path: 'b.md', chunk: 0, scale: 1, vector: int8([90]) },
    ]);
    const result = await scanCandidates(conn, new Float32Array([1]), 1, 10, new Set(['b.md']));
    assert.deepEqual(
      result.map((r) => r.path),
      ['b.md']
    );
  });
});

describe('scanSimilar', () => {
  it('ranks by max chunk-pair cosine and never returns the target path itself', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'target.md', 0);
    insertPending(db, 'near.md', 0);
    insertPending(db, 'far.md', 0);
    await writeVectorBatch(conn, [
      { path: 'target.md', chunk: 0, scale: 1, vector: int8([100]) },
      { path: 'near.md', chunk: 0, scale: 1, vector: int8([90]) },
      { path: 'far.md', chunk: 0, scale: 1, vector: int8([10]) },
    ]);
    const result = await scanSimilar(conn, 'target.md', { exclude: new Set(), k: 10 });
    assert.deepEqual(
      result.map((r) => r.path),
      ['near.md', 'far.md']
    );
  });

  it('honors the exclude and allowed filters', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'target.md', 0);
    insertPending(db, 'a.md', 0);
    insertPending(db, 'b.md', 0);
    await writeVectorBatch(conn, [
      { path: 'target.md', chunk: 0, scale: 1, vector: int8([100]) },
      { path: 'a.md', chunk: 0, scale: 1, vector: int8([100]) },
      { path: 'b.md', chunk: 0, scale: 1, vector: int8([100]) },
    ]);

    const excluded = await scanSimilar(conn, 'target.md', { exclude: new Set(['a.md']), k: 10 });
    assert.deepEqual(
      excluded.map((r) => r.path),
      ['b.md']
    );

    const allowed = await scanSimilar(conn, 'target.md', { exclude: new Set(), allowed: new Set(['b.md']), k: 10 });
    assert.deepEqual(
      allowed.map((r) => r.path),
      ['b.md']
    );
  });

  it('returns [] when the target note has no embedded chunks', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'no-vectors.md', 0); // vector stays NULL
    insertPending(db, 'other.md', 0);
    await writeVectorBatch(conn, [{ path: 'other.md', chunk: 0, scale: 1, vector: int8([100]) }]);
    assert.deepEqual(await scanSimilar(conn, 'no-vectors.md', { exclude: new Set(), k: 10 }), []);
  });

  it('samples seed chunks under TARGET_CHUNK_CAP: an unsampled chunk cannot skew the score', async () => {
    const { db, conn } = makeDb();
    // TARGET_CHUNK_CAP is 16; 20 target chunks -> step = ceil(20/16) = 2, sampling even indices
    // (0, 2, 4, ..., 18). Index 1 is odd and therefore never sampled.
    const chunkCount = 20;
    for (let i = 0; i < chunkCount; i++) insertPending(db, 'target.md', i);
    insertPending(db, 'other.md', 0);

    const rows: Array<{ path: string; chunk: number; scale: number; vector: Buffer }> = [];
    for (let i = 0; i < chunkCount; i++) {
      if (i === 1) {
        // Unsampled: a dominant score that would hijack the result if sampling were broken
        // and every chunk got scanned instead of just the seeded subset.
        rows.push({ path: 'target.md', chunk: i, scale: 100, vector: int8([127]) });
      } else if (i === 0) {
        rows.push({ path: 'target.md', chunk: i, scale: 0.01, vector: int8([10]) });
      } else {
        rows.push({ path: 'target.md', chunk: i, scale: 1, vector: int8([0]) });
      }
    }
    rows.push({ path: 'other.md', chunk: 0, scale: 1, vector: int8([1]) });
    await writeVectorBatch(conn, rows);

    const result = await scanSimilar(conn, 'target.md', { exclude: new Set(), k: 10 });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'other.md');
    // 0.1 = sampled chunk 0's score (10 * 0.01 * 1). Chunk 1's score (127 * 100 * 1 = 12700,
    // clamped to 1) would win here if the cap did not limit seeding to the sampled subset.
    assert.equal(result[0].similarity, 0.1, 'an unsampled chunk (index 1) must not affect the score');
  });
});

describe('pendingRows', () => {
  it('returns only rows whose vector is NULL, ordered by path then chunk', async () => {
    const { db, conn } = makeDb();
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

describe('hasVectorRow', () => {
  it('distinguishes no rows, rows still pending, and at least one embedded chunk', async () => {
    const { db, conn } = makeDb();
    assert.equal(await hasVectorRow(conn, 'missing.md'), false);

    insertPending(db, 'pending.md', 0);
    assert.equal(await hasVectorRow(conn, 'pending.md'), false);

    insertPending(db, 'partial.md', 0);
    insertPending(db, 'partial.md', 1);
    await writeVectorBatch(conn, [{ path: 'partial.md', chunk: 1, scale: 1, vector: int8([1]) }]);
    assert.equal(await hasVectorRow(conn, 'partial.md'), true);
  });
});

describe('writeVectorBatch', () => {
  it('writes scale and vector for exactly the targeted (path, chunk) rows, leaving others pending', async () => {
    const { db, conn } = makeDb();
    insertPending(db, 'a.md', 0);
    insertPending(db, 'a.md', 1);
    insertPending(db, 'b.md', 0);

    await writeVectorBatch(conn, [
      { path: 'a.md', chunk: 0, scale: 0.5, vector: int8([42]) },
      { path: 'b.md', chunk: 0, scale: 0.25, vector: int8([-7]) },
    ]);

    assert.deepEqual(await pendingRows(conn), [{ path: 'a.md', chunk: 1 }]);
    const row = db.prepare('SELECT scale, vector FROM embeddings WHERE "path" = ? AND chunk = ?').get('a.md', 0) as { scale: number; vector: Uint8Array };
    assert.equal(row.scale, 0.5);
    assert.equal(new Int8Array(row.vector.buffer, row.vector.byteOffset, 1)[0], 42);
  });
});
