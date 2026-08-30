import type { Connection, VectorCandidate, VectorSimilar, VectorWriteRow } from '../types.ts';
import { asCosine, sampleEvenly } from '../vectors.ts';

// Native F32_BLOB(dims) columns, dims fixed at DDL time (open.ts, STORE_DIMS). Both scans
// score in JS: a per-row vector_distance_cos measured 3.5-8x slower on this row engine.

// A model narrower than the column zero-pads: the added dimensions contribute nothing to
// either dot product or norm, so cosine is unchanged.
function padded(values: ArrayLike<number>, dims: number): Float32Array {
  const out = new Float32Array(dims);
  for (let d = 0; d < Math.min(values.length, dims); d++) out[d] = values[d];
  return out;
}

// A bound Float32Array stores truncated bytes with no error; a Buffer view over the same
// bytes round-trips exact (measured 0.7.2).
function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function decode(vector: Buffer, dims: number): Float32Array {
  return new Float32Array(vector.buffer, vector.byteOffset, dims);
}

// Rows arrive int8-quantized with a per-vector scale (embed/query.ts's toStore); this store
// dequantizes to floats, as duckdb does.
function dequantize(row: VectorWriteRow, dims: number): Float32Array {
  const q = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
  const out = new Float32Array(dims);
  for (let d = 0; d < Math.min(q.length, dims); d++) out[d] = q[d] * row.scale;
  return out;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let d = 0; d < a.length; d++) {
    dot += a[d] * b[d];
    na += a[d] * a[d];
    nb += b[d] * b[d];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-32);
}

// `scale` stays NULL: the column exists so the row shape matches the other stores, and
// cosine is scale-invariant once the value is dequantized here.
export async function writeVectorBatch(conn: Connection, dims: number, rows: VectorWriteRow[]): Promise<void> {
  if (rows.length === 0) return;
  await conn.runBatch(
    'UPDATE embeddings SET vector = ? WHERE "path" = ? AND chunk = ?',
    rows.map((row) => [toBlob(dequantize(row, dims)), row.path, row.chunk])
  );
}

// Best chunk per file by cosine. GROUP BY with MIN() cannot do this on 0.7.2: the aggregate
// is right but the bare start_line/end_line come from an arbitrary row in the group.
export async function scanCandidates(conn: Connection, qv: Float32Array, dims: number, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  const q = padded(qv, dims);
  const stmt = await conn.prepare('SELECT "path", start_line, end_line, vector FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{ path: string; start_line: number; end_line: number; vector: Buffer }>;

  const best = new Map<string, { score: number; lines: string }>();
  for (const row of rows) {
    if (allowed && !allowed.has(row.path)) continue;
    const score = cosineSimilarity(q, decode(row.vector, dims));
    const existing = best.get(row.path);
    if (!existing || score > existing.score) best.set(row.path, { score, lines: `L${row.start_line}-${row.end_line}` });
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, fetch)
    .map(([path, b]) => ({ path, lines: b.lines, similarity: asCosine(b.score) }));
}

// Max cosine over (target chunk, other chunk) pairs. The SQL cross-join duckdb uses measured
// 6-8x slower here at 26k chunks (2026-08-30).
export async function scanSimilar(conn: Connection, dims: number, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  if (opts.allowed && opts.allowed.size === 0) return [];
  const targetStmt = await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk');
  const targetRows = (await targetStmt.all(path)) as Array<{ vector: Buffer }>;
  if (targetRows.length === 0) return [];
  const targets = sampleEvenly(targetRows).map((row) => decode(row.vector, dims));

  const stmt = await conn.prepare('SELECT "path", vector FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{ path: string; vector: Buffer }>;
  const best = new Map<string, number>();
  for (const row of rows) {
    if (row.path === path || opts.exclude.has(row.path) || (opts.allowed && !opts.allowed.has(row.path))) continue;
    const other = decode(row.vector, dims);
    for (const t of targets) {
      const score = cosineSimilarity(t, other);
      const existing = best.get(row.path);
      if (existing === undefined || score > existing) best.set(row.path, score);
    }
  }

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.k)
    .map(([p, score]) => ({ path: p, similarity: asCosine(score) }));
}
