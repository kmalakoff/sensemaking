import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../config.ts';
import { embedConfig } from '../config.ts';
import { SenseError } from '../errors.ts';
import { parseFile } from '../scan.ts';
import type { Feature } from './types.ts';

// embeddings(path, chunk, start_line, end_line, scale, vector): heading-based chunks,
// int8 vectors with a per-vector dequantization scale, vector NULL = not yet embedded.
// Reconcile stores dirty rows inside its transaction; embedding tops up on the next
// semantic query (embedPending), so staleness costs recall, never correctness.

// Storage lever fixed by the bake-off (BENCHMARKING.md): int8 at 256 dims is
// quality-free vs f32-512 when fused. Queries stay f32 at the same dims.
const STORE_DIMS = 256;
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

// Deterministic chunker used at reconcile (line ranges stored) and at embed time (text
// re-derived from the file -- chunk text is never stored). Heading-delimited with the
// preamble kept; whole file when no headings. The title/summary prefix mirrors the
// bm25 column weighting.
function chunksOf(raw: string, search?: { title: string; summary: string }): Chunk[] {
  const lines = raw.split('\n');
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
    if (text.length > 0) chunks.push({ startLine: start, endLine: end, text: prefix ? `${prefix}\n${text}` : text });
  });
  return chunks;
}

export const embed: Feature = {
  name: 'embed',
  schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  },
  extract(raw, _body, search) {
    return chunksOf(raw, search);
  },
  remove(db, path) {
    db.prepare('DELETE FROM embeddings WHERE "path" = ?').run(path);
  },
  store(db, path, extracted) {
    const insert = db.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)');
    (extracted as Chunk[]).forEach((c, idx) => insert.run(path, idx, c.startLine, c.endLine));
  },
};

// --- static type: Model2Vec safetensors + pure-JS tokenizer, model cached in ~/.cache ---
// Encode convention from model2vec/model.py: no special tokens, drop unk ids, mean-pool,
// L2-normalize.

function fetchToFile(url: string, dest: string): Promise<void> {
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new SenseError('EMBED_MODEL', `model download failed: ${url} -> HTTP ${res.status}`);
    writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${dest}.part`, dest);
  });
}

async function staticProvider(model: string): Promise<EmbedProvider> {
  let dir = model;
  if (!existsSync(join(dir, 'model.safetensors'))) {
    dir = join(homedir(), '.cache', 'sensemaking', 'models', model.replace(/\//g, '--'));
    mkdirSync(dir, { recursive: true });
    for (const file of ['model.safetensors', 'tokenizer.json']) {
      if (!existsSync(join(dir, file))) {
        console.error(`fetching ${model}/${file} into ${dir} (once; delete to refetch)`);
        await fetchToFile(`https://huggingface.co/${model}/resolve/main/${file}`, join(dir, file));
      }
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
  if (!e) throw new SenseError('EMBED_DISABLED', 'semantic expansion needs features.embed in sense.config.json (e.g. "features": { "embed": true })');
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
      chunks = parseFile({ relPath: path, absPath: join(baseDir, path), mtimeMs: 0, size: 0 }, [embed]).doc.extracted.embed as Chunk[];
    } catch {
      continue; // vanished since reconcile; the next reconcile removes its rows
    }
    for (const idx of chunkIdxs) if (chunks[idx]) jobs.push({ path, chunk: idx, text: chunks[idx].text });
  }

  const update = db.prepare('UPDATE embeddings SET scale = ?, vector = ? WHERE "path" = ? AND chunk = ?');
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
  }
}

// Top candidates by cosine for a semantic find: best chunk per file, its line range
// riding along. FTS5 operators in the terms are lexical syntax, not meaning -- stripped
// before embedding.
// Returns the cosine similarity alongside each candidate: stored and query vectors are both
// L2-normalised before quantisation, so the dot product is cosine in [-1, 1]. `find` surfaces
// it because the fused rank score cannot express match quality -- nearest-neighbour search
// always returns a nearest neighbour, so without a magnitude an agent cannot tell a real hit
// from the best of a bad lot.
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
    .map(([path, b]) => ({ path, lines: b.lines, similarity: Math.round(b.score * 1000) / 1000 }));
}
