import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, ResolvedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Chunk } from '../features/embed.ts';
import { embed } from '../features/embed.ts';
import { progress } from '../output/progress.ts';
import { parseFile } from '../scan/index.ts';
import type { Store, VectorCandidate, VectorSimilar } from '../store/types.ts';
import { takeChunkText } from './handoff.ts';
import { checkLanguageFit } from './langfit.ts';
import { getProvider } from './registry.ts';
import { STORE_DIMS } from './types.ts';

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

// Embed rows whose vector is NULL. Reconcile hands its chunk text over in memory when it ran in
// this process (handoff.ts); a row left pending by an earlier command re-derives from the file.
export async function embedPending(store: Store, cfg: Config, baseDir: string): Promise<void> {
  const provider = await getProvider(cfg); // throws EMBED_DISABLED before touching the table
  const dirty = await store.vectors.pending();
  if (dirty.length === 0) return;
  const storeDims = Math.min(STORE_DIMS, provider.dims);

  const byPath = new Map<string, number[]>();
  for (const row of dirty) {
    const list = byPath.get(row.path) ?? [];
    list.push(row.chunk);
    byPath.set(row.path, list);
  }

  const textByPath = takeChunkText(store) ?? new Map<string, string[]>();

  const jobs: Array<{ path: string; chunk: number; text: string }> = [];
  for (const [path, chunkIdxs] of byPath) {
    const texts = textByPath.get(path);
    if (texts && chunkIdxs.every((idx) => idx < texts.length)) {
      // A stat, not a parse: a file that vanished since reconcile is skipped here even though its
      // text comes from memory, and the next reconcile removes its rows.
      if (!existsSync(join(baseDir, path))) continue;
      for (const idx of chunkIdxs) jobs.push({ path, chunk: idx, text: texts[idx] });
      continue;
    }
    // Reconcile ran in another process (`sense map` earlier, or a background `sense watch`), so
    // its chunk text is gone: re-derive this one file.
    let chunks: Chunk[];
    try {
      chunks = parseFile({ relPath: path, absPath: join(baseDir, path), mtimeMs: 0, ctimeMs: 0, size: 0, presets: [], embed: true }, [embed], cfg).doc.extracted.embed as Chunk[];
    } catch {
      continue; // vanished since reconcile; the next reconcile removes its rows
    }
    for (const idx of chunkIdxs) if (chunks[idx]) jobs.push({ path, chunk: idx, text: chunks[idx].text });
  }

  // Over the exact texts about to be embedded, before any of them are: a mismatch fails
  // this run loudly instead of quietly storing vectors from the wrong model.
  await checkLanguageFit(
    store,
    provider,
    jobs.map((j) => j.text)
  );

  // The lazy build is the one long silence a first search hits (measured 23s at
  // 26k notes); progress makes it distinguishable from a hang.
  const report = progress('embedding chunks', jobs.length);
  for (let i = 0; i < jobs.length; i += provider.batchCap) {
    const batch = jobs.slice(i, i + provider.batchCap);
    const vectors = await provider.embedDocuments(batch.map((j) => j.text));
    await store.vectors.writeVectors(
      batch.map((job, j) => {
        const { v, scale } = toStore(vectors[j], storeDims, true);
        const q = new Int8Array(storeDims);
        for (let d = 0; d < storeDims; d++) q[d] = Math.round(v[d] / scale);
        return { path: job.path, chunk: job.chunk, scale, vector: Buffer.from(q.buffer) };
      })
    );
    report.tick(Math.min(i + provider.batchCap, jobs.length));
  }
  report.finish();
}

// Best chunk per file by cosine, its line range riding along; FTS5 operators are stripped as
// lexical syntax. Similarity comes back because the fused score cannot express match quality.
export async function semanticCandidates(store: Store, cfg: Config, terms: string, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  const baseDir = (cfg as Partial<ResolvedConfig>).baseDir;
  if (!baseDir) throw new SenseError('EMBED_MODEL', 'semantic expansion needs a config with baseDir (use loadConfig/open)');
  await embedPending(store, cfg, baseDir);

  const provider = await getProvider(cfg);
  const storeDims = Math.min(STORE_DIMS, provider.dims);
  const text = (terms.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t)).join(' ');
  const { v: qv } = toStore(await provider.embedQuery(text), storeDims, false);

  return store.vectors.candidates(qv, storeDims, fetch, allowed);
}

// Whether a note has any chunk with a vector. Distinguishes "nothing is near this note" from
// "this note has no text", which look the same in an empty result.
export async function hasEmbedding(store: Store, path: string): Promise<boolean> {
  return store.vectors.hasVector(path);
}

// Note-to-note similarity is the max cosine over (target chunk, other chunk) pairs, one linear
// scan of stored vectors.
export async function similarNotes(store: Store, _cfg: Config, path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]> {
  return store.vectors.similar(path, opts);
}
