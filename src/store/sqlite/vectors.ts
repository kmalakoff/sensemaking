import type { Connection, VectorCandidate, VectorSimilar, VectorWriteRow } from '../types.ts';
import { asCosine, compareVectorScores, sampleEvenly } from '../vectors.ts';

// One runBatch call per provider batch: the caller (embed/query.ts) already batches by the
// provider's batchCap, so this is one crossing per batch, never per row.
export async function writeVectorBatch(conn: Connection, rows: VectorWriteRow[]): Promise<void> {
  if (rows.length === 0) return;
  await conn.runBatch(
    'UPDATE embeddings SET scale = ?, vector = ? WHERE "path" = ? AND chunk = ?',
    rows.map((row) => [row.scale, row.vector, row.path, row.chunk])
  );
}

// Best chunk per file by cosine, its line range riding along: the JS loop over stored int8
// BLOBs this store's scan strategy is (a native store scans differently, same contract).
export async function scanCandidates(conn: Connection, qv: Float32Array, storeDims: number, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  const stmt = await conn.prepare('SELECT "path", chunk, start_line, end_line, vector FROM embeddings WHERE vector IS NOT NULL ORDER BY "path", chunk');
  const rows = (await stmt.all()) as Array<{
    path: string;
    chunk: number;
    start_line: number;
    end_line: number;
    vector: Uint8Array;
  }>;

  let queryNorm = 0;
  for (let d = 0; d < Math.min(storeDims, qv.length); d++) queryNorm += qv[d] * qv[d];
  queryNorm = Math.sqrt(queryNorm);

  const best = new Map<string, { score: number; chunk: number; lines: string }>();
  for (const row of rows) {
    if (allowed && !allowed.has(row.path)) continue;
    const q = new Int8Array(row.vector.buffer, row.vector.byteOffset, Math.min(storeDims, row.vector.byteLength));
    // Rounding to int8 costs the stored row its unit norm, so dividing by that norm is what makes
    // this a cosine rather than a scaled dot product. `scale` cancels out of the ratio.
    let dot = 0;
    let norm = 0;
    const length = Math.min(q.length, qv.length);
    for (let d = 0; d < length; d++) {
      dot += q[d] * qv[d];
      norm += q[d] * q[d];
    }
    for (let d = length; d < q.length; d++) norm += q[d] * q[d];
    const score = norm === 0 || queryNorm === 0 ? 0 : dot / (Math.sqrt(norm) * queryNorm);
    const existing = best.get(row.path);
    if (!existing || score > existing.score || (score === existing.score && row.chunk < existing.chunk)) {
      best.set(row.path, { score, chunk: row.chunk, lines: `L${row.start_line}-${row.end_line}` });
    }
  }
  return [...best.entries()]
    .map(([path, value]) => ({ path, ...value }))
    .sort(compareVectorScores)
    .slice(0, fetch)
    .map(({ path, lines, score }) => ({ path, lines, similarity: asCosine(score) }));
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, one linear
// scan of stored vectors.
export async function scanSimilar(conn: Connection, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  const targetStmt = await conn.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk');
  const targetRows = (await targetStmt.all(path)) as Array<{ vector: Uint8Array }>;
  if (targetRows.length === 0) return [];
  // Each side's norm divides its own dot product, so both are taken once here rather than per pair.
  const target = sampleEvenly(targetRows).map((row) => {
    const v = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
    let norm = 0;
    for (let d = 0; d < v.length; d++) norm += v[d] * v[d];
    return { v, norm: Math.sqrt(norm) };
  });

  const stmt = await conn.prepare('SELECT "path", vector FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{ path: string; vector: Uint8Array }>;
  const best = new Map<string, number>();
  for (const row of rows) {
    if (row.path === path || opts.exclude.has(row.path) || (opts.allowed && !opts.allowed.has(row.path))) continue;
    const other = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
    let otherNorm = 0;
    for (let d = 0; d < other.length; d++) otherNorm += other[d] * other[d];
    otherNorm = Math.sqrt(otherNorm);
    for (const t of target) {
      let dot = 0;
      const len = Math.min(t.v.length, other.length);
      for (let d = 0; d < len; d++) dot += t.v[d] * other[d];
      const score = t.norm === 0 || otherNorm === 0 ? 0 : dot / (t.norm * otherNorm);
      const existing = best.get(row.path);
      if (existing === undefined || score > existing) best.set(row.path, score);
    }
  }

  return [...best.entries()]
    .map(([p, score]) => ({ path: p, score }))
    .sort(compareVectorScores)
    .slice(0, opts.k)
    .map(({ path: p, score }) => ({ path: p, similarity: asCosine(score) }));
}
