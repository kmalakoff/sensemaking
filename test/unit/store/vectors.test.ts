import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { writeVectorBatch } from '../../../src/store/sqlite/vectors.ts';
import type { Connection } from '../../../src/store/types.ts';
import { asCosine, hasVectorRow, pendingRows, sampleEvenly, TARGET_CHUNK_CAP } from '../../../src/store/vectors.ts';

// pendingRows/hasVectorRow are engine-neutral IS NULL/IS NOT NULL checks; sqlite's Connection is
// the lightest concrete one available (no optional native dependency), used only as a portable Connection, not to exercise sqlite-specific behavior.
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
