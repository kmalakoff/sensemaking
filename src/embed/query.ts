import type { Config, ResolvedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Chunk } from '../features/embed.ts';
import { embed } from '../features/embed.ts';
import { progress } from '../output/progress.ts';
import { parseSource } from '../scan/index.ts';
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
// this process (handoff.ts); a row left pending by an earlier command re-derives from the exact
// source string persisted with that indexed generation.
export async function embedPending(store: Store, cfg: Config, allowed?: ReadonlySet<string>): Promise<void> {
  const provider = await getProvider(cfg); // throws EMBED_DISABLED before touching the table
  const dirty = (await store.vectors.pending()).filter((row) => allowed?.has(row.path) ?? true);
  if (dirty.length === 0) return;
  const storeDims = Math.min(STORE_DIMS, provider.dims);

  const byPath = new Map<string, number[]>();
  for (const row of dirty) {
    const list = byPath.get(row.path) ?? [];
    list.push(row.chunk);
    byPath.set(row.path, list);
  }

  const textByPath = takeChunkText(store) ?? new Map<string, string[]>();
  const sourceStmt = await store.prepare('SELECT text FROM indexed_sources WHERE "path" = ?');

  const jobs: Array<{ path: string; chunk: number; text: string }> = [];
  for (const [path, chunkIdxs] of byPath) {
    const texts = textByPath.get(path);
    if (texts && chunkIdxs.every((idx) => idx < texts.length)) {
      for (const idx of chunkIdxs) jobs.push({ path, chunk: idx, text: texts[idx] });
      continue;
    }
    // A prior process may have reconciled the row, so its in-memory handoff is gone. Re-derive
    // from that indexed generation's stored source, never from a newer live file.
    const source = (await sourceStmt.get(path)) as { text: string } | undefined;
    if (!source) throw new SenseError('INDEX_NOT_READY', `indexed source text is missing for ${path}; run \`sense build --force\` (or library build(config, { force: true })) before preparing vectors`);
    const chunks = parseSource({ relPath: path, absPath: path, mtimeMs: 0, ctimeMs: 0, size: Buffer.byteLength(source.text), presets: [], embed: true }, source.text, [embed], cfg).doc.extracted.embed as Chunk[];
    for (const idx of chunkIdxs) {
      const chunk = chunks[idx];
      if (!chunk) throw new SenseError('INDEX_NOT_READY', `indexed vector metadata for ${path} does not match its indexed source; run \`sense build --force\` (or library build(config, { force: true }))`);
      jobs.push({ path, chunk: idx, text: chunk.text });
    }
  }

  // Over the exact texts about to be embedded, before any of them are: a mismatch fails
  // this run loudly instead of quietly storing vectors from the wrong model.
  await checkLanguageFit(
    store,
    provider,
    jobs.map((j) => j.text)
  );

  // Preparing a large configured scope can take long enough to look stalled, so report each
  // completed provider batch.
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

export async function ensureDocumentEmbeddings(store: Store, _cfg: Config, allowed: ReadonlySet<string>): Promise<void> {
  const pending = (await store.vectors.pending()).filter((row) => allowed.has(row.path));
  if (pending.length > 0) {
    throw new SenseError('INDEX_NOT_READY', `${pending.length} indexed chunk(s) in the requested scope still need vectors; run \`sense build\` (or library build(config)) before querying with build disabled`);
  }
}

// Best chunk per file by cosine, its line range riding along; FTS5 operators are stripped as
// lexical syntax. Similarity comes back because the fused score cannot express match quality.
export async function semanticCandidates(store: Store, cfg: Config, terms: string, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  const rootDir = (cfg as Partial<ResolvedConfig>).rootDir ?? (cfg as Partial<ResolvedConfig>).baseDir;
  if (!rootDir) throw new SenseError('EMBED_MODEL', 'semantic expansion needs a resolved config (use loadConfig/open)');
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
