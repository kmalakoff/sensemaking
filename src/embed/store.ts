import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.ts';
import { embedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { writeFileAtomic } from '../lib/atomic-write.ts';
import { type BufferedResponse, fetchWithRetry, HTTP_ATTEMPT_TIMEOUT_MS, MODEL_FILE_ATTEMPT_TIMEOUT_MS } from './http.ts';
import { DEFAULT_MODELS_ROOT, hasModelFiles, isDownloadable, languagesPath, MODEL_FILES, readRef, snapshotDir, writeLanguages, writeRef } from './identity.ts';
import { isKnownLanguageTag, MEASURED_MODEL_LANGUAGES } from './languages.ts';

// The Hub base for every request here; downloadModelRevision takes it as a parameter so a test can point it at a local server.
const HF_HUB = 'https://huggingface.co';

// identity.ts holds paths and cache identity, no network; store.ts holds the network fetches
// (downloads, sha resolution, language metadata), re-exported here for its network surface.
export { hasModelFiles, isDownloadable, MODEL_FILENAMES, MODEL_FILES, modelDir, readLanguages, refsMainPath, snapshotDir, writeLanguages, writeRef } from './identity.ts';

// A non-static provider has nothing to download here; an unreachable endpoint surfaces as an
// EMBED_MODEL error at call time instead.
export function modelPresent(cfg: Config): boolean {
  const e = embedConfig(cfg);
  if (!e) return false;
  return e.provider !== 'static' || hasModelFiles(e.model);
}

type ResolvedEmbedConfig = NonNullable<ReturnType<typeof embedConfig>>;

// True when embed.model names a local path (not a Hugging Face id) that is missing its model
// files -- nothing will ever fetch it for itself, unlike a downloadable id.
export function localModelMissing(e: ResolvedEmbedConfig | null): e is ResolvedEmbedConfig {
  return e !== null && e.provider === 'static' && !isDownloadable(e.model) && !hasModelFiles(e.model);
}

// `main` resolves to a sha once per model: a recorded ref pins until its snapshot is
// removed, so only the first need for an id ever costs this HEAD request.
async function resolveSha(model: string, root: string = DEFAULT_MODELS_ROOT): Promise<string> {
  const existing = readRef(model, root);
  if (existing) return existing;
  const url = `${HF_HUB}/${model}/resolve/main/model.safetensors`;
  // redirect: manual -- the header rides the Hub's own response; following the LFS/CDN
  // redirect would read the CDN's headers instead, which do not carry it.
  const res = await fetchWithRetry(url, { method: 'HEAD', redirect: 'manual' }, { attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS });
  const sha = res.headers.get('x-repo-commit');
  if (!sha) throw new SenseError('EMBED_MODEL', `${res.url}: response carried no x-repo-commit header`);
  writeRef(model, sha, root);
  return sha;
}

interface HfModelInfo {
  cardData?: { language?: string | string[] };
  tags?: string[];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'string');
}

function isHfModelInfo(value: unknown): value is HfModelInfo {
  if (value === null || typeof value !== 'object') return false;
  if ('tags' in value && value.tags !== undefined && !isStringArray(value.tags)) return false;
  if (!('cardData' in value) || value.cardData === undefined) return true;
  if (value.cardData === null || typeof value.cardData !== 'object') return false;
  if (!('language' in value.cardData) || value.cardData.language === undefined) return true;
  return typeof value.cardData.language === 'string' || isStringArray(value.cardData.language);
}

// cardData.language is the structured field; tags are a fallback for cards that only tag
// languages, filtered to recognized codes so an unrelated short tag is never mistaken for one.
function languagesFromCard(info: HfModelInfo): string[] | undefined {
  const lang = info.cardData?.language;
  if (typeof lang === 'string') return [lang];
  if (Array.isArray(lang) && lang.length > 0) return lang;
  const tagLangs = (info.tags ?? []).filter(isKnownLanguageTag);
  return tagLangs.length > 0 ? tagLangs : undefined;
}

// Unreachable metadata is not an error, only the language-fit check staying off, but it says so:
// the check that keeps a misfit model loud cannot itself go quiet (PRINCIPLES: no-silent-modes).
function cardUnreadable(model: string): void {
  console.error(`sense: could not read the model card for ${model}; the language-fit check is off until it resolves (retries on next run, or run \`sense download\`)`);
}

async function ensureLanguages(model: string, root: string = DEFAULT_MODELS_ROOT): Promise<void> {
  if (existsSync(languagesPath(model, root))) return;
  // A measured entry needs no card and no network, and stays deterministic offline.
  const measured = MEASURED_MODEL_LANGUAGES[model];
  if (measured) {
    writeLanguages(model, measured, root);
    return;
  }
  let res: BufferedResponse;
  try {
    res = await fetchWithRetry(`${HF_HUB}/api/models/${model}`, {}, { attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS });
  } catch {
    cardUnreadable(model);
    return;
  }
  if (!res.ok) {
    cardUnreadable(model);
    return;
  }
  let info: HfModelInfo;
  try {
    const decoded: unknown = JSON.parse(new TextDecoder().decode(res.body));
    if (!isHfModelInfo(decoded)) throw new Error('invalid model-card response');
    info = decoded;
  } catch {
    cardUnreadable(model);
    return;
  }
  writeLanguages(model, languagesFromCard(info) ?? [], root);
}

// What the Hub publishes for one file at a pinned commit: sha256 of the content for LFS files,
// the git blob sha1 for plain git files, plus the size.
interface ExpectedFile {
  kind: 'sha256' | 'git-sha1';
  hash: string;
  size: number;
}

interface HfTreeEntry {
  path: string;
  oid: string;
  size: number;
  lfs?: { oid: string; size: number };
}

function isHfTreeEntry(value: unknown): value is HfTreeEntry {
  if (value === null || typeof value !== 'object') return false;
  if (!('path' in value) || typeof value.path !== 'string') return false;
  if (!('oid' in value) || typeof value.oid !== 'string') return false;
  if (!('size' in value) || typeof value.size !== 'number') return false;
  if (!('lfs' in value) || value.lfs === undefined) return true;
  if (value.lfs === null || typeof value.lfs !== 'object') return false;
  return 'oid' in value.lfs && typeof value.lfs.oid === 'string' && 'size' in value.lfs && typeof value.lfs.size === 'number';
}

function isHfTree(value: unknown): value is HfTreeEntry[] {
  return Array.isArray(value) && value.every(isHfTreeEntry);
}

function unverifiable(model: string, sha: string, detail: string): SenseError {
  return new SenseError('EMBED_MODEL', `could not get the Hub's published hashes for ${model}@${sha.slice(0, 8)}: ${detail}; no model file was written. Retry \`sense download\`; if it repeats, something between this machine and Hugging Face is changing the response`);
}

async function fetchExpected(model: string, sha: string, files: string[], hub: string): Promise<Map<string, ExpectedFile>> {
  const url = `${hub}/api/models/${model}/tree/${sha}`;
  let res: BufferedResponse;
  try {
    res = await fetchWithRetry(url, {}, { attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS });
  } catch (err) {
    throw unverifiable(model, sha, `${url} failed (${(err as Error).message})`);
  }
  if (res.status !== 200) throw unverifiable(model, sha, `${url} -> HTTP ${res.status}`);
  let tree: unknown;
  try {
    tree = JSON.parse(new TextDecoder().decode(res.body));
  } catch {
    throw unverifiable(model, sha, `${url} did not return JSON`);
  }
  if (!isHfTree(tree)) throw unverifiable(model, sha, `${url} returned an unrecognized tree`);
  const expected = new Map<string, ExpectedFile>();
  for (const file of files) {
    const entry = tree.find((e) => e.path === file);
    if (!entry) throw unverifiable(model, sha, `the tree has no entry for ${file}`);
    expected.set(file, entry.lfs ? { kind: 'sha256', hash: entry.lfs.oid, size: entry.lfs.size } : { kind: 'git-sha1', hash: entry.oid, size: entry.size });
  }
  return expected;
}

// git blob id: sha1 over "blob <size>\0" then the bytes.
function digest(kind: ExpectedFile['kind'], bytes: Buffer): string {
  if (kind === 'sha256') return createHash('sha256').update(bytes).digest('hex');
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

async function fetchToFile(url: string, dest: string, expected: ExpectedFile, label: string): Promise<void> {
  const res = await fetchWithRetry(url, {}, { attemptTimeoutMs: MODEL_FILE_ATTEMPT_TIMEOUT_MS });
  if (!res.ok) throw new SenseError('EMBED_MODEL', `${res.url} -> HTTP ${res.status}`);
  const bytes = Buffer.from(res.body);
  const mismatch = (actual: string) =>
    new SenseError('EMBED_MODEL', `${label} does not match the Hub's published ${expected.kind}: expected ${expected.hash.slice(0, 12)} (${expected.size} bytes), got ${actual}; ${label} was not written. Retry \`sense download\`; if it repeats, something between this machine and Hugging Face is changing the file`);
  if (bytes.byteLength !== expected.size) throw mismatch(`${bytes.byteLength} bytes`);
  const actual = digest(expected.kind, bytes);
  if (actual !== expected.hash) throw mismatch(`${actual.slice(0, 12)} (${bytes.byteLength} bytes)`);
  writeFileAtomic(dest, bytes);
}

// Fetches an already-known sha straight into its snapshot dir, without touching refs/main --
// for downloadModel below, and for callers pinning an exact revision (the parity suite).
// Each fetched file is verified against the Hub's published hash before it is written.
export async function downloadModelRevision(model: string, sha: string, onFile?: (file: string, dir: string) => void, root: string = DEFAULT_MODELS_ROOT, hub: string = HF_HUB): Promise<string> {
  const dir = snapshotDir(model, sha, root);
  mkdirSync(dir, { recursive: true });
  // Files already on disk are not re-hashed (0.3 s per open), including ones written before
  // verification existed; removing the snapshot folder re-downloads and verifies them.
  const missing = MODEL_FILES.filter((file) => !existsSync(join(dir, file)));
  if (missing.length === 0) return dir;
  const expected = await fetchExpected(model, sha, missing, hub);
  for (const file of missing) {
    const want = expected.get(file);
    if (!want) throw unverifiable(model, sha, `no expected value for ${file}`);
    onFile?.(file, dir);
    await fetchToFile(`${hub}/${model}/resolve/${sha}/${file}`, join(dir, file), want, `${model}@${sha.slice(0, 8)}/${file}`);
  }
  return dir;
}

// The only code path that resolves `main`: a static provider's first construction calls it
// lazily, `sense download` as an explicit prefetch. Idempotent either way.
export async function downloadModel(model: string, onFile?: (file: string, dir: string) => void, root: string = DEFAULT_MODELS_ROOT): Promise<string> {
  if (!isDownloadable(model)) {
    throw new SenseError('EMBED_MODEL', `embed.model "${model}" is a local path, not a Hugging Face model id, so there is nothing to download; put model.safetensors and tokenizer.json in that directory, or name a model id like "minishlab/potion-retrieval-32M"`);
  }
  const sha = await resolveSha(model, root);
  // Independent of the weights above: a fresh HEAD/GET pair either way, so a lazy first
  // construction and an explicit prefetch both end up with a cached language verdict.
  await ensureLanguages(model, root);
  return downloadModelRevision(model, sha, onFile, root);
}
