import type { DuckDBConnection, DuckDBType, DuckDBValue } from '@duckdb/node-api';
import { withTransaction } from '../transaction.ts';
import type { Connection, VectorCandidate, VectorSimilar, VectorWriteRow } from '../types.ts';
import { rewriteUpdate } from './batch.ts';

// This store keeps vectors as native FLOAT[dims] arrays (dims fixed at DDL time by
// duckdb/open.ts's ensureSchema, from embed/types.ts's STORE_DIMS) and scans them with
// array_cosine_similarity, pushing top-k into SQL instead of pulling every row into JS --
// sqlite's int8+scale BLOB scan (src/store/sqlite/vectors.ts) is the other store's own
// representation and stays as it is. Every function here takes `dims` as a parameter rather
// than importing STORE_DIMS directly, so it is testable at any width (store.ts wires the real
// constant at the call site).

// Loaded lazily, same as duckdb/open.ts's connect(): a value import of '@duckdb/node-api'
// must never sit at module top level, or a sqlite-only tree would resolve this optional
// dependency just by importing store/index.ts. By the time any function below runs, open()
// already imported it successfully, so this just returns the cached module.
let api: Promise<typeof import('@duckdb/node-api')> | undefined;
function duckdbApi(): Promise<typeof import('@duckdb/node-api')> {
  if (!api) api = import('@duckdb/node-api');
  return api;
}

// A bind position whose type is left to auto-inference (safe for plain strings/numbers; only
// the vector ARRAY positions below need an explicit type -- see writeVectorBatch's comment).
const untyped = undefined as unknown as DuckDBType;

// Seed chunks that participate in a `related` scan; must match sqlite/vectors.ts's
// TARGET_CHUNK_CAP for identical sampling behavior (see that file for the measurement it's
// based on -- 12.7s at 201 chunks/note without sampling).
const TARGET_CHUNK_CAP = 16;

// array_cosine_similarity is already a true cosine (no int8 accumulation to push slightly
// outside [-1, 1]), but rounded the same way sqlite's scores are so both stores print the
// same bounded number rather than one having more decimal noise than the other.
function asCosine(score: number): number {
  return Math.round(Math.min(1, Math.max(-1, score)) * 1000) / 1000;
}

// The DDL-fixed array width can exceed a vector's actual length (a hypothetical model sliced
// under the column's width); zero-padding leaves cosine scores unchanged since the added
// dimensions contribute nothing to either vector's dot product or norm.
function padded(values: ArrayLike<number>, dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  for (let d = 0; d < Math.min(values.length, dims); d++) out[d] = values[d];
  return out;
}

function inClause(column: string, count: number): string {
  return `${column} IN (${Array.from({ length: count }, () => '?').join(', ')})`;
}

// Rows arrive int8-quantized with a per-vector scale (the wire format embed/query.ts produces
// for every store, see toStore); dequantizing into a plain float array is this store's own
// representation choice, so both stores are handed the same vectors and diverge only here.
function dequantize(row: VectorWriteRow, dims: number): number[] {
  const q = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
  return padded(
    Array.from(q, (v) => v * row.scale),
    dims
  );
}

// One runBatch-equivalent call per provider batch: a single multi-row UPDATE (batch.ts's
// rewriteUpdate, the same rewrite Connection.runBatch uses), bound directly against the native
// connection because the vector column needs an explicit ARRAY(DOUBLE, dims) bind type --
// automatic type inference on the raw values misreads an all-integer first component (a real
// vector's exact 0.0 is common) as an INTEGER array and silently truncates the rest of the row
// (verified against a live connection: an untyped bind of [0, 0.35, 0.1, -0.2] stores [0,0,0,0]).
export async function writeVectorBatch(duckdb: DuckDBConnection, conn: Connection, dims: number, rows: VectorWriteRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { arrayValue, ARRAY, DOUBLE } = await duckdbApi();
  const rewritten = rewriteUpdate('UPDATE embeddings SET vector = ? WHERE "path" = ? AND chunk = ?', rows.length);
  if (!rewritten) throw new Error('duckdb: writeVectorBatch SQL shape not recognized by rewriteUpdate');

  await withTransaction(conn, async () => {
    const stmt = await duckdb.prepare(rewritten.sql);
    try {
      const values: DuckDBValue[] = [];
      const types: DuckDBType[] = [];
      for (const row of rows) {
        values.push(arrayValue(dequantize(row, dims)), row.path, row.chunk);
        types.push(ARRAY(DOUBLE, dims), untyped, untyped);
      }
      stmt.bind(values, types);
      await stmt.run();
    } finally {
      stmt.destroySync();
    }
  });
}

// Best chunk per file by cosine, its line range riding along, entirely in SQL: arg_max picks
// the winning chunk's line range from the same row max(score) came from, per path. An empty
// `allowed` set matches sqlite's scan (every row filtered out) without touching the table.
export async function scanCandidates(duckdb: DuckDBConnection, qv: Float32Array, dims: number, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  if (allowed && allowed.size === 0) return [];
  const { arrayValue, ARRAY, DOUBLE } = await duckdbApi();
  const allowedList = allowed ? [...allowed] : [];
  const sql = `SELECT "path", arg_max(start_line, score) AS start_line, arg_max(end_line, score) AS end_line, max(score) AS score
    FROM (
      SELECT "path", start_line, end_line, array_cosine_similarity(vector, ?) AS score
      FROM embeddings
      WHERE vector IS NOT NULL ${allowed ? `AND ${inClause('"path"', allowedList.length)}` : ''}
    ) sub
    GROUP BY "path"
    ORDER BY score DESC
    LIMIT ?`;
  const stmt = await duckdb.prepare(sql);
  try {
    const values: DuckDBValue[] = [arrayValue(padded(qv, dims)), ...allowedList, fetch];
    const types: DuckDBType[] = [ARRAY(DOUBLE, dims), ...allowedList.map(() => untyped), untyped];
    stmt.bind(values, types);
    const reader = await stmt.runAndReadAll();
    const rows = reader.getRowObjectsJS() as Array<{ path: string; start_line: number; end_line: number; score: number }>;
    return rows.map((r) => ({ path: r.path, lines: `L${r.start_line}-${r.end_line}`, similarity: asCosine(r.score) }));
  } finally {
    stmt.destroySync();
  }
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, pushed
// into one native scan: the sampled target vectors become a small VALUES list, cross-joined
// against every stored vector and reduced with max()/GROUP BY, so the O(target x stored) cost
// the plan measures (12.7s at 201 chunks/note in JS) runs vectorized instead of scalar.
export async function scanSimilar(duckdb: DuckDBConnection, conn: Connection, dims: number, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  if (opts.allowed && opts.allowed.size === 0) return [];
  const targetStmt = await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk');
  const targetRows = (await targetStmt.all(path)) as Array<{ vector: number[] }>;
  if (targetRows.length === 0) return [];
  const step = Math.max(1, Math.ceil(targetRows.length / TARGET_CHUNK_CAP));
  const targets = targetRows.filter((_, i) => i % step === 0).map((row) => row.vector);

  const { arrayValue, ARRAY, DOUBLE } = await duckdbApi();
  const excludeList = [...opts.exclude];
  const allowedList = opts.allowed ? [...opts.allowed] : [];
  const sql = `WITH targets(tv) AS (VALUES ${targets.map(() => '(?)').join(', ')})
    SELECT e."path" AS path, max(array_cosine_similarity(e.vector, t.tv)) AS score
    FROM embeddings e, targets t
    WHERE e.vector IS NOT NULL AND e."path" != ?
      ${excludeList.length > 0 ? `AND NOT ${inClause('e."path"', excludeList.length)}` : ''}
      ${opts.allowed ? `AND ${inClause('e."path"', allowedList.length)}` : ''}
    GROUP BY e."path"
    ORDER BY score DESC
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
