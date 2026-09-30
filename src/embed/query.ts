import { type Config, featureSignature, type ResolvedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Chunk } from '../features/embed.ts';
import { embed } from '../features/embed.ts';
import { FEATURES } from '../features/index.ts';
import { progress } from '../output/progress.ts';
import { parseSource } from '../scan/index.ts';
import { FEATURE_SIGNATURE_META_KEY } from '../store/readiness.ts';
import { getMeta } from '../store/shared.ts';
import { embeddingSignatureCompatible } from '../store/signature.ts';
import type { Store, VectorCandidate, VectorSimilar } from '../store/types.ts';
import { identifyChunkText, takeChunkText } from './handoff.ts';
import { checkLanguageFit } from './langfit.ts';
import { getProvider } from './registry.ts';
import { type EmbedCallOptions, STORE_DIMS } from './types.ts';

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
function staleEmbeddingWork(reason: string): SenseError {
  return new SenseError('INDEX_NOT_READY', `${reason}; run \`sense build\` (or library build(config)) again to prepare the current index generation`);
}

// expectedSignature is captured by open() before provider work. Direct internal callers omit it
// and capture the durable value here, before selecting chunks or constructing a provider.
export async function embedPending(store: Store, cfg: Config, allowed?: ReadonlySet<string>, expectedSignature?: string | null, options: EmbedCallOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const expectedDurableSignature = expectedSignature === undefined ? await getMeta(store, FEATURE_SIGNATURE_META_KEY) : expectedSignature;
  options.signal?.throwIfAborted();
  if (!embeddingSignatureCompatible(expectedDurableSignature, featureSignature(cfg, FEATURES))) {
    throw staleEmbeddingWork('the index configuration changed before vectors could be prepared');
  }

  const pendingStmt = await store.prepare('SELECT "path", chunk, content_identity FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk');
  const dirty = ((await pendingStmt.all()) as Array<{ path: string; chunk: number; content_identity: string }>).filter((row) => allowed?.has(row.path) ?? true);
  options.signal?.throwIfAborted();
  if (dirty.length === 0) return;

  const provider = await getProvider(cfg, options);
  options.signal?.throwIfAborted();
  const submittedSignature = featureSignature(cfg, FEATURES);
  if (!embeddingSignatureCompatible(expectedDurableSignature, submittedSignature)) {
    throw staleEmbeddingWork('the index configuration changed while the embedding provider was being prepared');
  }
  const storeDims = Math.min(STORE_DIMS, provider.dims);

  const byPath = new Map<string, typeof dirty>();
  for (const row of dirty) {
    const list = byPath.get(row.path) ?? [];
    list.push(row);
    byPath.set(row.path, list);
  }

  const textByPath = takeChunkText(store) ?? new Map();
  const sourceStmt = await store.prepare('SELECT text FROM indexed_sources WHERE "path" = ?');

  const jobs: Array<{ path: string; chunk: number; text: string; identity: string }> = [];
  for (const [path, pending] of byPath) {
    const texts = textByPath.get(path);
    if (texts && pending.every((row) => texts[row.chunk]?.identity === row.content_identity)) {
      for (const row of pending) jobs.push({ path, chunk: row.chunk, ...texts[row.chunk] });
      continue;
    }
    // A prior process may have reconciled the row, so its in-memory handoff is gone. Re-derive
    // from that indexed generation's stored source, never from a newer live file.
    const source = (await sourceStmt.get(path)) as { text: string } | undefined;
    options.signal?.throwIfAborted();
    if (!source) throw new SenseError('INDEX_NOT_READY', `indexed source text is missing for ${path}; run \`sense build --force\` (or library build(config, { force: true })) before preparing vectors`);
    const chunks = parseSource({ relPath: path, absPath: path, mtimeMs: 0, ctimeMs: 0, size: Buffer.byteLength(source.text), presets: [], embed: true }, source.text, [embed], cfg).doc.extracted.embed as Chunk[];
    for (const row of pending) {
      const chunk = chunks[row.chunk];
      if (!chunk) throw new SenseError('INDEX_NOT_READY', `indexed vector metadata for ${path} does not match its indexed source; run \`sense build --force\` (or library build(config, { force: true }))`);
      const identified = identifyChunkText(chunk.text);
      if (identified.identity !== row.content_identity) throw staleEmbeddingWork(`indexed chunk ${path}#${row.chunk} changed before vectors could be prepared`);
      jobs.push({ path, chunk: row.chunk, ...identified });
    }
  }

  // Over the exact texts about to be embedded, before any of them are: a mismatch fails
  // this run loudly instead of quietly storing vectors from the wrong model.
  options.signal?.throwIfAborted();
  await checkLanguageFit(
    store,
    provider,
    jobs.map((j) => j.text)
  );
  options.signal?.throwIfAborted();

  // Preparing a large configured scope can take long enough to look stalled, so report each
  // completed provider batch.
  const report = progress('embedding chunks', jobs.length);
  for (let i = 0; i < jobs.length; i += provider.batchCap) {
    const batch = jobs.slice(i, i + provider.batchCap);
    options.signal?.throwIfAborted();
    if (featureSignature(cfg, FEATURES) !== submittedSignature) throw staleEmbeddingWork('the embedding configuration changed before a provider batch was submitted');
    const vectors = await provider.embedDocuments(
      batch.map((j) => j.text),
      options
    );
    options.signal?.throwIfAborted();
    if (featureSignature(cfg, FEATURES) !== submittedSignature) throw staleEmbeddingWork('the embedding configuration changed while a provider batch was running');
    const writes = batch.map((job, j) => {
      const { v, scale } = toStore(vectors[j], storeDims, true);
      const q = new Int8Array(storeDims);
      for (let d = 0; d < storeDims; d++) q[d] = Math.round(v[d] / scale);
      return { path: job.path, chunk: job.chunk, scale, vector: Buffer.from(q.buffer) };
    });
    options.signal?.throwIfAborted();
    await store.transaction(async () => {
      // Write first so SQLite owns the write lock before the fence reads. Any mismatch throws
      // inside this transaction and rolls every row in the provider batch back together.
      options.signal?.throwIfAborted();
      await store.vectors.writeVectors(writes);
      options.signal?.throwIfAborted();
      if ((await getMeta(store, FEATURE_SIGNATURE_META_KEY)) !== expectedDurableSignature) throw staleEmbeddingWork('the durable embedding configuration changed while a provider batch was running');
      const currentStmt = await store.prepare(`SELECT "path", chunk, content_identity FROM embeddings WHERE ${batch.map(() => '("path" = ? AND chunk = ?)').join(' OR ')}`);
      const current = (await currentStmt.all(...batch.flatMap((job) => [job.path, job.chunk]))) as Array<{ path: string; chunk: number; content_identity: string }>;
      const identities = new Map(current.map((row) => [`${row.path}\0${Number(row.chunk)}`, row.content_identity]));
      if (batch.some((job) => identities.get(`${job.path}\0${job.chunk}`) !== job.identity)) throw staleEmbeddingWork('indexed chunks changed while a provider batch was running');
      options.signal?.throwIfAborted();
    });
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

export interface PreparedSemanticQuery {
  readonly vector: Float32Array;
  readonly storeDims: number;
}

// Provider/model work is independent of the index snapshot. FTS5 operators are stripped as
// lexical syntax before the query is embedded, matching the prior semantic query behavior.
export async function prepareSemanticQuery(cfg: Config, terms: string, options: EmbedCallOptions = {}): Promise<PreparedSemanticQuery> {
  const rootDir = (cfg as Partial<ResolvedConfig>).rootDir ?? (cfg as Partial<ResolvedConfig>).baseDir;
  if (!rootDir) throw new SenseError('EMBED_MODEL', 'semantic expansion needs a resolved config (use loadConfig/open)');
  const text = (terms.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t)).join(' ');
  options.signal?.throwIfAborted();
  const provider = await getProvider(cfg, options);
  options.signal?.throwIfAborted();
  const storeDims = Math.min(STORE_DIMS, provider.dims);
  const queryVector = await provider.embedQuery(text, options);
  options.signal?.throwIfAborted();
  const { v: qv } = toStore(queryVector, storeDims, false);
  return { vector: qv, storeDims };
}

// Best chunk per file by cosine, its line range riding along. The caller owns the read snapshot
// and the prepared vector, so this performs no provider work and only delegates to the store.
export function semanticCandidates(store: Store, prepared: PreparedSemanticQuery, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]> {
  return store.vectors.candidates(prepared.vector, prepared.storeDims, fetch, allowed);
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
