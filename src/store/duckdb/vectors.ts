import type { DuckDBConnection, DuckDBType, DuckDBValue } from '@duckdb/node-api';
import { withTransaction } from '../transaction.ts';
import type { Connection, VectorCandidate, VectorSimilar, VectorWriteRow } from '../types.ts';
import { asCosine, sampleEvenly } from '../vectors.ts';
import { duckdbApi } from './native.ts';

// This store keeps vectors as native FLOAT[dims] arrays (dims fixed at DDL time by open.ts's ensureSchema, from embed/types.ts's STORE_DIMS) and
// scans them with array_cosine_similarity, pushing top-k into SQL instead of pulling every row into JS; sqlite's int8+scale BLOB scan is its own representation. Every function here takes `dims` as a parameter rather than importing STORE_DIMS directly, so it stays testable at any width.

// A value import of '@duckdb/node-api' must never sit at module top level, or a sqlite-only tree would resolve this optional dependency
// just by importing store/index.ts; native.ts's shared duckdbApi() keeps that lazy and reuses whatever open.ts already resolved.

// A bind position whose type is left to auto-inference (safe for plain strings/numbers; only
// the vector ARRAY positions below need an explicit type -- see writeVectorBatch's comment).
const untyped = undefined as unknown as DuckDBType;
const VECTOR_WRITE_STAGE = '_sense_vector_write_stage';

// Created once per native connection outside write transactions; its lifetime follows that connection.
export async function createVectorWriteStage(duckdb: DuckDBConnection, dims: number): Promise<void> {
  await duckdb.run(`CREATE TEMP TABLE ${VECTOR_WRITE_STAGE} ("path" TEXT, chunk INTEGER, vector FLOAT[${dims}])`);
}

// The DDL-fixed array width can exceed a vector's actual length (a hypothetical model sliced under the column's width);
// zero-padding leaves cosine scores unchanged since the added dimensions contribute nothing to either vector's dot product or norm.
function padded(values: ArrayLike<number>, dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  for (let d = 0; d < Math.min(values.length, dims); d++) out[d] = values[d];
  return out;
}

function inClause(column: string, count: number): string {
  return `${column} IN (${Array.from({ length: count }, () => '?').join(', ')})`;
}

// Rows arrive int8-quantized with a per-vector scale (the wire format embed/query.ts produces for every store, see toStore);
// dequantizing into a plain float array is this store's own representation choice, so both stores are handed the same vectors and diverge only here.
function dequantize(row: VectorWriteRow, dims: number): number[] {
  const q = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
  return padded(
    Array.from(q, (v) => v * row.scale),
    dims
  );
}

// The native appender needs an explicit FLOAT array type: inference from an integer first component
// silently truncates fractional components. The fixed UPDATE keeps each provider batch keyed by path and chunk.
export async function writeVectorBatch(duckdb: DuckDBConnection, conn: Connection, dims: number, rows: VectorWriteRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { ARRAY, FLOAT } = await duckdbApi();
  const vectorType = ARRAY(FLOAT, dims);

  await withTransaction(conn, async () => {
    await duckdb.run(`DELETE FROM ${VECTOR_WRITE_STAGE}`);
    const appender = await duckdb.createAppender(VECTOR_WRITE_STAGE);
    try {
      for (const row of rows) {
        appender.appendVarchar(row.path);
        appender.appendInteger(row.chunk);
        appender.appendArray(dequantize(row, dims), vectorType);
        appender.endRow();
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
    await duckdb.run(`UPDATE embeddings SET vector = staged.vector FROM ${VECTOR_WRITE_STAGE} AS staged WHERE embeddings."path" = staged."path" AND embeddings.chunk = staged.chunk`);
  });
}

// Best chunk per file by cosine, with the earliest chunk winning exact score ties.
// An empty `allowed` set matches sqlite's scan (every row filtered out) without touching the table.
export async function scanCandidates(duckdb: DuckDBConnection, qv: Float32Array, dims: number, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  if (allowed && allowed.size === 0) return [];
  const { arrayValue, ARRAY, DOUBLE } = await duckdbApi();
  const allowedList = allowed ? [...allowed] : [];
  const query = padded(qv, dims);
  const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
  const score = queryNorm === 0 ? '0.0' : 'CASE WHEN array_inner_product(vector, vector) = 0 THEN 0.0 ELSE array_cosine_similarity(vector, ?) END';
  const sql = `SELECT "path", start_line, end_line, score
    FROM (
      SELECT "path", start_line, end_line, score,
        row_number() OVER (PARTITION BY "path" ORDER BY score DESC, chunk ASC) AS selected
      FROM (
        SELECT "path", chunk, start_line, end_line, ${score} AS score
        FROM embeddings
        WHERE vector IS NOT NULL ${allowed ? `AND ${inClause('"path"', allowedList.length)}` : ''}
      ) sub
    ) ranked
    WHERE selected = 1
    ORDER BY score DESC, "path" ASC
    LIMIT ?`;
  const stmt = await duckdb.prepare(sql);
  try {
    const values: DuckDBValue[] = [...(queryNorm === 0 ? [] : [arrayValue(query)]), ...allowedList, fetch];
    const types: DuckDBType[] = [...(queryNorm === 0 ? [] : [ARRAY(DOUBLE, dims)]), ...allowedList.map(() => untyped), untyped];
    stmt.bind(values, types);
    const reader = await stmt.runAndReadAll();
    const rows = reader.getRowObjectsJS() as Array<{ path: string; start_line: number; end_line: number; score: number }>;
    return rows.map((r) => ({ path: r.path, lines: `L${r.start_line}-${r.end_line}`, similarity: asCosine(r.score) }));
  } finally {
    stmt.destroySync();
  }
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, pushed into one native scan: the sampled target vectors become
// a small VALUES list, cross-joined against every stored vector and reduced with max()/GROUP BY, so the O(target x stored) cost (12.7s at 201 chunks/note in JS) runs vectorized instead of scalar.
export async function scanSimilar(duckdb: DuckDBConnection, conn: Connection, dims: number, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  if (opts.allowed && opts.allowed.size === 0) return [];
  const targetStmt = await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk');
  const targetRows = (await targetStmt.all(path)) as Array<{ vector: number[] }>;
  if (targetRows.length === 0) return [];
  const targets = sampleEvenly(targetRows).map((row) => row.vector);

  const { arrayValue, ARRAY, DOUBLE } = await duckdbApi();
  const excludeList = [...opts.exclude];
  const allowedList = opts.allowed ? [...opts.allowed] : [];
  const sql = `WITH targets(tv) AS (VALUES ${targets.map(() => '(?)').join(', ')}), grouped AS (
    SELECT e."path" AS path, max(CASE WHEN array_inner_product(e.vector, e.vector) = 0 OR array_inner_product(t.tv, t.tv) = 0 THEN 0.0 ELSE array_cosine_similarity(e.vector, t.tv) END) AS score
    FROM embeddings e, targets t
    WHERE e.vector IS NOT NULL AND e."path" != ?
      ${excludeList.length > 0 ? `AND NOT ${inClause('e."path"', excludeList.length)}` : ''}
      ${opts.allowed ? `AND ${inClause('e."path"', allowedList.length)}` : ''}
    GROUP BY e."path"
  )
    SELECT path, score FROM grouped
    ORDER BY score DESC, path ASC
    LIMIT ?`;
  const stmt = await duckdb.prepare(sql);
  try {
    const values: DuckDBValue[] = [...targets.map((t) => arrayValue(padded(t, dims))), path, ...excludeList, ...allowedList, opts.k];
    const types: DuckDBType[] = [...targets.map(() => ARRAY(DOUBLE, dims)), untyped, ...excludeList.map(() => untyped), ...allowedList.map(() => untyped), untyped];
    stmt.bind(values, types);
    const reader = await stmt.runAndReadAll();
    const rows = reader.getRowObjectsJS() as Array<{ path: string; score: number }>;
    return rows.map((r) => ({ path: r.path, similarity: asCosine(r.score) }));
  } finally {
    stmt.destroySync();
  }
}
