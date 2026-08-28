import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Chunk } from '../features/embed.ts';
import { embed } from '../features/embed.ts';
import { progress } from '../output/progress.ts';
import { parseFile } from '../scan/index.ts';
import { checkLanguageFit } from './langfit.ts';
import { getProvider } from './registry.ts';

// Storage lever fixed by the bake-off (benchmark/reports/2026-08-13-static-model-bakeoff.md):
// int8 at 256 dims is quality-free vs f32-512 when fused. Queries stay f32 at the same dims.
const STORE_DIMS = 256;
// Seed chunks that participate in a `related` scan; see similarNotes for the measurement.
const TARGET_CHUNK_CAP = 16;

// Slice + re-normalize (Matryoshka); optionally round through int8 storage. Exported for
// benchmark/lib/embed.mjs, which scores the same lever math offline.
export function toStore(full: Float32Array, dims: number, int8: boolean): { v: Float32Array; scale: number } {
  const v = new Float32Array(dims);
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += full[d] * full[d];
  norm = Math.sqrt(norm) + 1e-32;
  for (let d = 0; d < dims; d++) v[d] = full[d] / norm;
  if (!int8) return { v, scale: 1 };
  let max = 0;
  for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(v[d]));
  return { v, scale: max / 127 || 1 };
}

// Embed rows whose vector is NULL, re-deriving chunk text from the files through the
// same parse + chunker that stored the rows.
export async function embedPending(db: DatabaseSync, cfg: Config, baseDir: string): Promise<void> {
  const provider = await getProvider(cfg); // throws EMBED_DISABLED before touching the table
  const dirty = db.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk').all() as Array<{ path: string; chunk: number }>;
  if (dirty.length === 0) return;
  const storeDims = Math.min(STORE_DIMS, provider.dims);

  const byPath = new Map<string, number[]>();
  for (const row of dirty) {
    const list = byPath.get(row.path) ?? [];
    list.push(row.chunk);
    byPath.set(row.path, list);
  }

  const jobs: Array<{ path: string; chunk: number; text: string }> = [];
  for (const [path, chunkIdxs] of byPath) {
    let chunks: Chunk[];
    try {
      // presets/embed are irrelevant here -- re-deriving chunk text for a doc that already
      // has embeddings rows means the tree had an embedding model at reconcile time.
      chunks = parseFile({ relPath: path, absPath: join(baseDir, path), mtimeMs: 0, ctimeMs: 0, size: 0, presets: [], embed: true }, [embed], cfg).doc.extracted.embed as Chunk[];
    } catch {
      continue; // vanished since reconcile; the next reconcile removes its rows
    }
    for (const idx of chunkIdxs) if (chunks[idx]) jobs.push({ path, chunk: idx, text: chunks[idx].text });
  }

  // Over the exact texts about to be embedded, before any of them are: a mismatch fails
  // this run loudly instead of quietly storing vectors from the wrong model.
  await checkLanguageFit(
    db,
    provider,
    jobs.map((j) => j.text)
  );

  const update = db.prepare('UPDATE embeddings SET scale = ?, vector = ? WHERE "path" = ? AND chunk = ?');
  // The lazy build is the one long silence a first search hits (measured 23s at
  // 26k notes); progress makes it distinguishable from a hang.
  const report = progress('embedding chunks', jobs.length);
  for (let i = 0; i < jobs.length; i += provider.batchCap) {
    const batch = jobs.slice(i, i + provider.batchCap);
    const vectors = await provider.embedDocuments(batch.map((j) => j.text));
    db.exec('BEGIN');
    try {
      batch.forEach((job, j) => {
        const { v, scale } = toStore(vectors[j], storeDims, true);
        const q = new Int8Array(storeDims);
        for (let d = 0; d < storeDims; d++) q[d] = Math.round(v[d] / scale);
        update.run(scale, Buffer.from(q.buffer), job.path, job.chunk);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    report.tick(Math.min(i + provider.batchCap, jobs.length));
  }
  report.finish();
}

// Dequantised int8 dot products land a little either side of a true cosine, so an identical
// pair prints 1.001 and undermines a column whose whole job is being a bounded number.
function asCosine(score: number): number {
  return Math.round(Math.min(1, Math.max(-1, score)) * 1000) / 1000;
}

// Best chunk per file by cosine, its line range riding along; FTS5 operators are stripped as
// lexical syntax. Similarity comes back because the fused score cannot express match quality,
// and nearest-neighbour search always returns a neighbour however far away.
export async function semanticCandidates(db: DatabaseSync, cfg: Config, terms: string, fetch: number, allowed?: Set<string>): Promise<Array<{ path: string; lines: string; similarity: number }>> {
  const baseDir = (cfg as Partial<ResolvedConfig>).baseDir;
  if (!baseDir) throw new SenseError('EMBED_MODEL', 'semantic expansion needs a config with baseDir (use loadConfig/open)');
  await embedPending(db, cfg, baseDir);

  const provider = await getProvider(cfg);
  const storeDims = Math.min(STORE_DIMS, provider.dims);
  const text = (terms.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t)).join(' ');
  const { v: qv } = toStore(await provider.embedQuery(text), storeDims, false);

  const rows = db.prepare('SELECT "path", start_line, end_line, scale, vector FROM embeddings WHERE vector IS NOT NULL').all() as Array<{
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

// Whether a note has any chunk with a vector. Distinguishes "nothing is near this note" from
// "this note has no text", which look the same in an empty result.
export function hasEmbedding(db: DatabaseSync, path: string): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM embeddings WHERE "path" = ? AND vector IS NOT NULL LIMIT 1').get(path) as { ok: number } | undefined;
  return row !== undefined;
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, one linear
// scan of stored vectors. Reads only what is stored, so it stays sync.
export function similarNotes(db: DatabaseSync, _cfg: Config, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Array<{ path: string; similarity: number }> {
  // Cost is target_chunks x stored_chunks, so a heading-dense seed multiplies a full-corpus
  // scan (12.7s at 201 chunks/note). Sample evenly, so late sections still get a vote.
  const targetRows = db.prepare('SELECT scale, vector FROM embeddings WHERE "path" = ? AND vector IS NOT NULL ORDER BY chunk').all(path) as Array<{ scale: number; vector: Uint8Array }>;
  if (targetRows.length === 0) return [];
  const step = Math.max(1, Math.ceil(targetRows.length / TARGET_CHUNK_CAP));
  const target = targetRows.filter((_, i) => i % step === 0).map((row) => ({ v: new Int8Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength), scale: row.scale }));

  const rows = db.prepare('SELECT "path", scale, vector FROM embeddings WHERE vector IS NOT NULL').all() as Array<{ path: string; scale: number; vector: Uint8Array }>;
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
