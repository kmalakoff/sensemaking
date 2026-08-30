import type { Connection, VectorCandidate, VectorSimilar, VectorWriteRow } from '../types.ts';
import { asCosine, sampleEvenly } from '../vectors.ts';

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
  const stmt = await conn.prepare('SELECT "path", start_line, end_line, scale, vector FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{
    path: string;
    start_line: number;
    end_line: number;
    scale: number;
    vector: Uint8Array;
  }>;

  const best = new Map<string, { score: number; lines: string }>();
  for (const row of rows) {
    if (allowed && !allowed.has(row.path)) continue;
    const q = new Int8Array(row.vector.buffer, row.vector.byteOffset, Math.min(storeDims, row.vector.byteLength));
    let dot = 0;
    for (let d = 0; d < q.length; d++) dot += q[d] * qv[d];
    const score = dot * row.scale;
    const existing = best.get(row.path);
    if (!existing || score > existing.score) best.set(row.path, { score, lines: `L${row.start_line}-${row.end_line}` });
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, fetch)
    .map(([path, b]) => ({ path, lines: b.lines, similarity: asCosine(b.score) }));
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, one linear
// scan of stored vectors.
export async function scanSimilar(conn: Connection, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  const targetStmt = await conn.prepare('SELECT scale, vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk');
  const targetRows = (await targetStmt.all(path)) as Array<{ scale: number; vector: Uint8Array }>;
  if (targetRows.length === 0) return [];
  const target = sampleEvenly(targetRows).map((row) => ({ v: new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), scale: row.scale }));

  const stmt = await conn.prepare('SELECT "path", scale, vector FROM embeddings WHERE vector IS NOT NULL');
  const rows = (await stmt.all()) as Array<{ path: string; scale: number; vector: Uint8Array }>;
  const best = new Map<string, number>();
  for (const row of rows) {
    if (row.path === path || opts.exclude.has(row.path) || (opts.allowed && !opts.allowed.has(row.path))) continue;
    const other = new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
    for (const t of target) {
      let dot = 0;
      const len = Math.min(t.v.length, other.length);
      for (let d = 0; d < len; d++) dot += t.v[d] * other[d];
      const score = dot * t.scale * row.scale;
      const existing = best.get(row.path);
      if (existing === undefined || score > existing) best.set(row.path, score);
    }
  }

  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.k)
    .map(([p, score]) => ({ path: p, similarity: asCosine(score) }));
}
