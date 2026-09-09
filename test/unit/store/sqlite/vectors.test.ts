import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { toStore } from '../../../../src/embed/query.ts';
import { createConnection } from '../../../../src/store/sqlite/connection.ts';
import { scanCandidates, scanSimilar, writeVectorBatch } from '../../../../src/store/sqlite/vectors.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { pendingRows } from '../../../../src/store/vectors.ts';
import { assertSeparatedScores, cosineOracle, quantizeVector, separatedVectorFixture, VECTOR_DIMS } from '../../../lib/vectors.ts';

const DIMS = VECTOR_DIMS;

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

describe('int8 quantization round trip', () => {
  it('a vector stored then scored against its own query form ranks near cosine 1', async () => {
    await withDb(async (db, conn) => {
      const full = new Float32Array([3, -1, 4, 1, -5, 9, 2, -6]);
      const { v: qv } = toStore(full, DIMS, false); // query form: normalized f32, unquantized
      const { scale, vector } = quantizeVector(full, DIMS);
      insertPending(db, 'a.md', 0);
      await writeVectorBatch(conn, [{ path: 'a.md', chunk: 0, scale, vector }]);

      const [top] = await scanCandidates(conn, qv, DIMS, 5);
      assert.equal(top.path, 'a.md');
      assert.ok(top.similarity > 0.99, `expected near-1 cosine for an identical vector, got ${top.similarity}`);
    });
  });

  it('treats stored scale as quantization metadata, not vector magnitude', async () => {
    await withDb(async (db, conn) => {
      insertPending(db, 'weak.md', 0);
      insertPending(db, 'strong.md', 0);
      // Both rows point in the same direction. Cosine is invariant to their different scales.
      await writeVectorBatch(conn, [
        { path: 'weak.md', chunk: 0, scale: 0.1, vector: int8([100, 0]) },
        { path: 'strong.md', chunk: 0, scale: 1.0, vector: int8([50, 0]) },
      ]);
      const result = await scanCandidates(conn, new Float32Array([2, 0]), 2, 2);
      assert.deepEqual(
        result.map((r) => r.path),
        ['strong.md', 'weak.md'],
        'equal public cosine scores use deterministic path order'
      );
      assert.deepEqual(
        result.map((r) => r.similarity),
        [1, 1]
      );
    });
  });
});

describe('scanCandidates', () => {
  it('orders separated mixed-direction vectors by descending cosine similarity', async () => {
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      const rows = [
        ['exact.md', fixture.exact],
        ['diagonal.md', fixture.diagonal],
        ['orthogonal.md', fixture.orthogonal],
        ['anti.md', fixture.antiParallel],
      ] as const;
      for (const [path] of rows) insertPending(db, path, 0);
      await writeVectorBatch(
        conn,
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
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      insertPending(db, 'a.md', 0, 1, 5);
      insertPending(db, 'a.md', 1, 6, 10);
      await writeVectorBatch(conn, [
        { path: 'a.md', chunk: 0, ...quantizeVector(fixture.orthogonal) },
        { path: 'a.md', chunk: 1, ...quantizeVector(fixture.exact) },
      ]);
      const result = await scanCandidates(conn, fixture.query, DIMS, 10);
      assert.equal(result.length, 1, 'one path should appear once, deduped to its best chunk');
      assert.equal(result[0].lines, 'L6-10', 'the higher-scoring chunk (1) should win, not the first inserted');
    });
  });

  it('narrows candidates to the allowed set', async () => {
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      insertPending(db, 'a.md', 0);
      insertPending(db, 'b.md', 0);
      await writeVectorBatch(conn, [
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

  it('returns a finite neutral score for a zero stored vector', async () => {
    await withDb(async (db, conn) => {
      insertPending(db, 'zero.md', 0);
      insertPending(db, 'exact.md', 0);
      await writeVectorBatch(conn, [
        { path: 'zero.md', chunk: 0, scale: 1 / 127, vector: int8([0, 0]) },
        { path: 'exact.md', chunk: 0, scale: 1 / 127, vector: int8([127, 0]) },
      ]);
      const query = new Float32Array([3, 0]);
      const result = await scanCandidates(conn, query, 2, 10);
      assert.deepEqual(
        result.map((r) => r.path),
        ['exact.md', 'zero.md']
      );
      assert.equal(result.find((r) => r.path === 'zero.md')?.similarity, 0);
      assert.equal(result.find((r) => r.path === 'exact.md')?.similarity, Math.round(cosineOracle([127, 0], query) * 1000) / 1000);
    });
  });

  it('orders distinct raw cosines before applying public score rounding', async () => {
    await withDb(async (db, conn) => {
      insertPending(db, 'z-near.md', 0);
      insertPending(db, 'a-near.md', 0);
      const scale = 1 / 127;
      await writeVectorBatch(conn, [
        { path: 'z-near.md', chunk: 0, scale, vector: int8([127, 1]) },
        { path: 'a-near.md', chunk: 0, scale, vector: int8([127, 2]) },
      ]);
      const query = new Float32Array([1, 0]);
      const expected = [cosineOracle([127, 1], query), cosineOracle([127, 2], query)];
      assert.ok(expected[0] > expected[1]);
      assert.equal(Math.round(expected[0] * 1000) / 1000, 1);
      assert.equal(Math.round(expected[1] * 1000) / 1000, 1);
      const result = await scanCandidates(conn, query, 2, 2);
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

describe('scanSimilar', () => {
  it('ranks by max chunk-pair cosine and never returns the target path itself', async () => {
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      const rows = [
        ['target.md', fixture.exact],
        ['near.md', fixture.diagonal],
        ['far.md', fixture.orthogonal],
        ['anti.md', fixture.antiParallel],
      ] as const;
      for (const [path] of rows) insertPending(db, path, 0);
      await writeVectorBatch(
        conn,
        rows.map(([path, vector]) => ({ path, chunk: 0, ...quantizeVector(vector) }))
      );
      const result = await scanSimilar(conn, 'target.md', { exclude: new Set(), k: 10 });
      assert.deepEqual(
        result.map((r) => r.path),
        ['near.md', 'far.md', 'anti.md']
      );
      assert.ok(result[0].similarity > result[1].similarity);
      assert.ok(result[1].similarity > result[2].similarity);
    });
  });

  it('honors the exclude and allowed filters', async () => {
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      insertPending(db, 'target.md', 0);
      insertPending(db, 'a.md', 0);
      insertPending(db, 'b.md', 0);
      await writeVectorBatch(conn, [
        { path: 'target.md', chunk: 0, ...quantizeVector(fixture.exact) },
        { path: 'a.md', chunk: 0, ...quantizeVector(fixture.diagonal) },
        { path: 'b.md', chunk: 0, ...quantizeVector(fixture.orthogonal) },
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
  });

  it('returns [] when the target note has no embedded chunks', async () => {
    await withDb(async (db, conn) => {
      const fixture = separatedVectorFixture();
      insertPending(db, 'no-vectors.md', 0); // vector stays NULL
      insertPending(db, 'other.md', 0);
      await writeVectorBatch(conn, [{ path: 'other.md', chunk: 0, ...quantizeVector(fixture.exact) }]);
      assert.deepEqual(await scanSimilar(conn, 'no-vectors.md', { exclude: new Set(), k: 10 }), []);
    });
  });

  it('uses the neutral zero score for a zero target and orders zero-score results by path', async () => {
    await withDb(async (db, conn) => {
      insertPending(db, 'target.md', 0);
      insertPending(db, 'z.md', 0);
      insertPending(db, 'a.md', 0);
      const scale = 1 / 127;
      await writeVectorBatch(conn, [
        { path: 'target.md', chunk: 0, scale, vector: int8([0, 0]) },
        { path: 'z.md', chunk: 0, scale, vector: int8([127, 0]) },
        { path: 'a.md', chunk: 0, scale, vector: int8([0, 127]) },
      ]);
      const result = await scanSimilar(conn, 'target.md', { exclude: new Set(), k: 10 });
      assert.deepEqual(
        result.map((r) => r.path),
        ['a.md', 'z.md']
      );
      assert.deepEqual(
        result.map((r) => r.similarity),
        [0, 0]
      );
    });
  });

  it('samples seed chunks under TARGET_CHUNK_CAP: an unsampled chunk cannot skew the score', async () => {
    await withDb(async (db, conn) => {
      // TARGET_CHUNK_CAP is 16; 20 target chunks -> step = ceil(20/16) = 2, sampling even indices
      // (0, 2, 4, ..., 18). Index 1 is odd and therefore never sampled.
      const chunkCount = 20;
      for (let i = 0; i < chunkCount; i++) insertPending(db, 'target.md', i);
      insertPending(db, 'other.md', 0);

      const rows: Array<{ path: string; chunk: number; scale: number; vector: Buffer }> = [];
      for (let i = 0; i < chunkCount; i++) {
        if (i === 1) {
          // Unsampled: a parallel vector that would hijack the result if sampling were broken.
          rows.push({ path: 'target.md', chunk: i, scale: 1 / 127, vector: int8([0, 127]) });
        } else if (i === 0) {
          rows.push({ path: 'target.md', chunk: i, scale: 1 / 127, vector: int8([127, 0]) });
        } else {
          rows.push({ path: 'target.md', chunk: i, scale: 1 / 127, vector: int8([0, 0]) });
        }
      }
      rows.push({ path: 'other.md', chunk: 0, scale: 1 / 127, vector: int8([0, 127]) });
      await writeVectorBatch(conn, rows);

      const result = await scanSimilar(conn, 'target.md', { exclude: new Set(), k: 10 });
      assert.equal(result.length, 1);
      assert.equal(result[0].path, 'other.md');
      // Chunk 1's score is 1 but must not win here if the cap limits seeding to sampled chunks.
      assert.equal(result[0].similarity, 0, 'an unsampled chunk must not affect the score');
    });
  });
});

describe('writeVectorBatch', () => {
  it('writes scale and vector for exactly the targeted (path, chunk) rows, leaving others pending', async () => {
    await withDb(async (db, conn) => {
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
});
