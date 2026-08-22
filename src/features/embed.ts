import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../config.ts';
import { embedConfig } from '../config.ts';
import { SenseError } from '../errors.ts';
import { progress } from '../progress.ts';
import { parseFile } from '../scan.ts';
import type { Feature } from './types.ts';

// Heading-based chunks, int8 vectors with a per-vector scale, NULL vector = not yet embedded.
// Reconcile writes dirty rows; embedding tops up on the next search, so staleness costs recall.

// Storage lever fixed by the bake-off (BENCHMARKING.md): int8 at 256 dims is
// quality-free vs f32-512 when fused. Queries stay f32 at the same dims.
const STORE_DIMS = 256;
// Seed chunks that participate in a `related` scan; see similarNotes for the measurement.
const TARGET_CHUNK_CAP = 16;
const BATCH = 64;

export interface EmbedProvider {
  id: string; // model identity; participates in the cache key, change -> re-embed
  dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

// Deterministic, so embed time can re-derive text from stored line ranges. Heading-delimited,
// preamble kept, whole body when no headings; the title/summary prefix mirrors bm25 weighting.
//
// Chunks the body, not the raw file, with `offset` shifting line numbers back onto the raw
// file so a range stays a direct Read range (sections is 1-indexed over raw too). Chunking raw
// put the frontmatter block in its own leading chunk on every note with a heading, which made
// `lines` point at YAML and made frontmatter-only notes near-identical to each other. It also
// disagreed with FTS, which indexes the body alone.
function chunksOf(body: string, search?: { title: string; summary: string }, offset = 0): Chunk[] {
  const lines = body.split('\n');
  const starts: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6} +/.test(lines[i])) starts.push(i + 1);
  }
  const bounds = starts.length === 0 ? [1] : starts[0] > 1 ? [1, ...starts] : starts;
  const prefix = [search?.title, search?.summary].filter(Boolean).join('\n');
  const chunks: Chunk[] = [];
  bounds.forEach((start, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1] - 1 : lines.length;
    const text = lines
      .slice(start - 1, end)
      .join('\n')
      .trim();
    // A body with nothing in it yields no chunks at all, so a frontmatter-only note has no
    // vectors rather than a vector of its own YAML.
    if (text.length > 0) chunks.push({ startLine: start + offset, endLine: end + offset, text: prefix ? `${prefix}\n${text}` : text });
  });
  return chunks;
}

export const embed: Feature = {
  name: 'embed',
  schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  },
  extract(raw, body, search) {
    // Lines the frontmatter occupies, so body line 1 maps back to its raw line number.
    return chunksOf(body, search, raw.split('\n').length - body.split('\n').length);
  },
  remove(db, path) {
    db.prepare('DELETE FROM embeddings WHERE "path" = ?').run(path);
  },
  // A tree with no embedding model never had extract() run for the doc (db.ts's per-file
  // filter skips it), so extracted is undefined here -- store nothing, i.e. no rows.
  store(db, path, extracted) {
    if (!extracted) return;
    const insert = db.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)');
    (extracted as Chunk[]).forEach((c, idx) => insert.run(path, idx, c.startLine, c.endLine));
  },
  enabledForFile(_cfg, file) {
    return file.embed;
  },
};

// --- static type: Model2Vec safetensors + pure-JS tokenizer, model cached in ~/.cache ---
// Encode convention from model2vec/model.py: no special tokens, drop unk ids, mean-pool,
// L2-normalize.

const MODEL_FILES = ['model.safetensors', 'tokenizer.json'];
// The pair, for messages that name what a local model directory must contain.
export const MODEL_FILENAMES = MODEL_FILES.join(' and ');

// A Hugging Face repo id: one slash, HF's charset. Anything else is a path, used as one rather
// than flattened into a cache key Windows would reject.
const HF_MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

// Downloadable iff it names a Hugging Face repo; a local path is the caller's to populate.
export function isDownloadable(model: string): boolean {
  return HF_MODEL_ID.test(model);
}

// Machine-wide, not per-tree: `.sense/` is the index a rebuild throws away, while a 124 MB
// model is shared by every tree on the machine. Honors XDG_CACHE_HOME where it is set;
// elsewhere ~/.cache, which is also where Hugging Face's own libraries keep theirs.
function cacheRoot(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache'), 'sensemaking', 'models');
}

// A model is either a local directory the caller pointed at, or the cache `sense download`
// fills. Nothing here fetches: an absent model degrades search to its other signals rather
// than pulling 124 MB out of a command that reads like a query.
export function modelDir(model: string): string {
  if (!HF_MODEL_ID.test(model)) return model;
  return join(cacheRoot(), model.replace(/\//g, '--'));
}

// Both files, so an interrupted download reads as absent and the next one resumes it.
export function hasModelFiles(model: string): boolean {
  const dir = modelDir(model);
  return MODEL_FILES.every((file) => existsSync(join(dir, file)));
}

// api providers have nothing to download, so they are never "missing" here; an unreachable
// endpoint surfaces as an EMBED_MODEL error at call time instead.
export function modelPresent(cfg: Config): boolean {
  const e = embedConfig(cfg);
  if (!e) return false;
  return e.type === 'api' || hasModelFiles(e.model);
}

function fetchToFile(url: string, dest: string): Promise<void> {
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new SenseError('EMBED_MODEL', `model download failed: ${url} -> HTTP ${res.status}`);
    writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${dest}.part`, dest);
  });
}

// The only code path that touches the network for weights. `sense download` calls it; no
// query ever does. Idempotent: a file already on disk is left alone.
export async function downloadModel(model: string, onFile?: (file: string, dir: string) => void): Promise<string> {
  if (!isDownloadable(model)) {
    throw new SenseError('EMBED_MODEL', `embed.model "${model}" is a local path, not a Hugging Face model id, so there is nothing to download; put model.safetensors and tokenizer.json in that directory, or name a model id like "minishlab/potion-retrieval-32M"`);
  }
  const dir = modelDir(model);
  mkdirSync(dir, { recursive: true });
  for (const file of MODEL_FILES) {
    if (existsSync(join(dir, file))) continue;
    onFile?.(file, dir);
    await fetchToFile(`https://huggingface.co/${model}/resolve/main/${file}`, join(dir, file));
  }
  return dir;
}

async function staticProvider(model: string): Promise<EmbedProvider> {
  const dir = modelDir(model);
  for (const file of MODEL_FILES) {
    if (!existsSync(join(dir, file))) {
      // A local path the caller controls gets told what is missing where; only a repo id can
      // be fixed by downloading.
      const fix = isDownloadable(model) ? 'run `sense download`' : `expected ${MODEL_FILENAMES} in that directory`;
      throw new SenseError('EMBED_MODEL_MISSING', `embed model ${model} is not available (looked in ${dir}); ${fix}`);
    }
  }

  const raw = readFileSync(join(dir, 'model.safetensors'));
  const headerLen = Number(raw.readBigUInt64LE(0));
  const header = JSON.parse(raw.subarray(8, 8 + headerLen).toString('utf8')) as Record<string, { dtype: string; shape: number[]; data_offsets: number[] }>;
  const entry = Object.entries(header).find(([k]) => k !== '__metadata__');
  if (!entry || entry[1].dtype !== 'F32') throw new SenseError('EMBED_MODEL', `${model}: expected an F32 safetensors matrix`);
  const spec = entry[1];
  const dims = spec.shape[1];
  const dataStart = raw.byteOffset + 8 + headerLen + spec.data_offsets[0];
  const matrix = dataStart % 4 === 0 ? new Float32Array(raw.buffer, dataStart, spec.shape[0] * dims) : new Float32Array(raw.buffer.slice(dataStart, dataStart + spec.shape[0] * dims * 4));

  const tokenizerJson = JSON.parse(readFileSync(join(dir, 'tokenizer.json'), 'utf8'));
  // Lazy import: the tokenizer loads only on the semantic path, never at CLI startup.
  const { Tokenizer } = await import('@huggingface/tokenizers');
  const tok = new Tokenizer(tokenizerJson, {});
  const unkId = tokenizerJson.model?.vocab?.[tokenizerJson.model?.unk_token] ?? -1;

  function one(text: string): Float32Array {
    // The tokenizer yields undefined (not the unk id) for tokens outside the vocab; an
    // undefined id would index the matrix at NaN and poison the whole mean-pool -- and the
    // int8 conversion then stores the NaN vector as all zeros, silently. Keep integers only.
    const ids = (tok.encode(text, { add_special_tokens: false }).ids as number[]).filter((id) => Number.isInteger(id) && id !== unkId);
    const v = new Float32Array(dims);
    if (ids.length === 0) return v;
    for (const id of ids) {
      const off = id * dims;
      for (let d = 0; d < dims; d++) v[d] += matrix[off + d];
    }
    let norm = 0;
    for (let d = 0; d < dims; d++) {
      v[d] /= ids.length;
      norm += v[d] * v[d];
    }
    norm = Math.sqrt(norm) + 1e-32;
    for (let d = 0; d < dims; d++) v[d] /= norm;
    return v;
  }

  return { id: `static:${model}`, dims, embed: async (texts) => texts.map(one) };
}

// --- api type: one POST against any OpenAI-compatible /embeddings endpoint ---

async function apiProvider(model: string, url: string | undefined, keyEnv: string | undefined): Promise<EmbedProvider> {
  if (!url) throw new SenseError('EMBED_MODEL', 'features.embed.type "api" requires a url');
  const base = url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  async function post(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${base}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model, input: texts }) });
    if (!res.ok) throw new SenseError('EMBED_MODEL', `${base}/embeddings -> HTTP ${res.status}`);
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return body.data.map((d) => Float32Array.from(d.embedding));
  }

  const dims = (await post(['dimension probe']))[0].length;
  return { id: `api:${base}:${model}`, dims, embed: post };
}

const providers = new Map<string, Promise<EmbedProvider>>();

function getProvider(cfg: Config): Promise<EmbedProvider> {
  const e = embedConfig(cfg);
  if (!e) throw new SenseError('EMBED_DISABLED', 'this tree has no embedding model: add an "embed" block naming one to sense.config.json, then run `sense download`');
  const sig = `${e.type}:${e.model}:${e.url ?? ''}`;
  let p = providers.get(sig);
  if (!p) {
    p = e.type === 'api' ? apiProvider(e.model, e.url, e.key) : staticProvider(e.model);
    providers.set(sig, p);
  }
  return p;
}

// Slice + re-normalize (Matryoshka); optionally round through int8 storage.
function toStore(full: Float32Array, dims: number, int8: boolean): { v: Float32Array; scale: number } {
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
      chunks = parseFile({ relPath: path, absPath: join(baseDir, path), mtimeMs: 0, size: 0, presets: [], embed: true }, [embed]).doc.extracted.embed as Chunk[];
    } catch {
      continue; // vanished since reconcile; the next reconcile removes its rows
    }
    for (const idx of chunkIdxs) if (chunks[idx]) jobs.push({ path, chunk: idx, text: chunks[idx].text });
  }

  const update = db.prepare('UPDATE embeddings SET scale = ?, vector = ? WHERE "path" = ? AND chunk = ?');
  // The lazy build is the one long silence a first search hits (measured 23s at
  // 26k notes); progress makes it distinguishable from a hang.
  const report = progress('embedding chunks', jobs.length);
  for (let i = 0; i < jobs.length; i += BATCH) {
    const batch = jobs.slice(i, i + BATCH);
    const vectors = await provider.embed(batch.map((j) => j.text));
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
    report.tick(Math.min(i + BATCH, jobs.length));
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
export async function semanticCandidates(db: DatabaseSync, cfg: Config, terms: string, fetch: number): Promise<Array<{ path: string; lines: string; similarity: number }>> {
  const baseDir = (cfg as Partial<ResolvedConfig>).baseDir;
  if (!baseDir) throw new SenseError('EMBED_MODEL', 'semantic expansion needs a config with baseDir (use loadConfig/open)');
  await embedPending(db, cfg, baseDir);

  const provider = await getProvider(cfg);
  const storeDims = Math.min(STORE_DIMS, provider.dims);
  const text = (terms.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t)).join(' ');
  const { v: qv } = toStore((await provider.embed([text]))[0], storeDims, false);

  const rows = db.prepare('SELECT "path", start_line, end_line, scale, vector FROM embeddings WHERE vector IS NOT NULL').all() as Array<{
    path: string;
    start_line: number;
    end_line: number;
    scale: number;
    vector: Uint8Array;
  }>;

  const best = new Map<string, { score: number; lines: string }>();
  for (const row of rows) {
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
