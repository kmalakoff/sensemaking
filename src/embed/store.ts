import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.ts';
import { embedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { writeFileAtomic } from '../lib/atomic-write.ts';
import { fetchWithRetry } from './http.ts';
import { hasModelFiles, isDownloadable, languagesPath, MODEL_FILES, readRef, snapshotDir, writeLanguages, writeRef } from './identity.ts';
import { isKnownLanguageTag, MEASURED_MODEL_LANGUAGES } from './languages.ts';

// identity.ts holds paths and cache identity, no network; store.ts holds the network fetches
// (downloads, sha resolution, language metadata). Re-exported here for callers that otherwise
// only need store.ts's network surface.
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
async function resolveSha(model: string): Promise<string> {
  const existing = readRef(model);
  if (existing) return existing;
  const url = `https://huggingface.co/${model}/resolve/main/model.safetensors`;
  // redirect: manual -- the header rides the Hub's own response; following the LFS/CDN
  // redirect would read the CDN's headers instead, which do not carry it.
  let res: Response;
  try {
    res = await fetchWithRetry(url, { method: 'HEAD', redirect: 'manual' });
  } catch (err) {
    throw new SenseError('EMBED_MODEL', `could not reach ${url}: ${(err as Error).message}`);
  }
  const sha = res.headers.get('x-repo-commit');
  if (!sha) throw new SenseError('EMBED_MODEL', `${url}: response carried no x-repo-commit header`);
  writeRef(model, sha);
  return sha;
}

interface HfModelInfo {
  cardData?: { language?: string | string[] };
  tags?: string[];
}

// cardData.language is the structured field (verified live: minishlab/potion-retrieval-32M has
// neither this nor any language tag, so it stays silent; potion-multilingual-128M carries an
// array here). Tags are a fallback for cards that only tag languages, filtered to recognized
// codes so an unrelated short tag (format markers etc.) is never mistaken for one.
function languagesFromCard(info: HfModelInfo): string[] | undefined {
  const lang = info.cardData?.language;
  if (typeof lang === 'string') return [lang];
  if (Array.isArray(lang) && lang.length > 0) return lang;
  const tagLangs = (info.tags ?? []).filter(isKnownLanguageTag);
  return tagLangs.length > 0 ? tagLangs : undefined;
}

// Best-effort, cached forever once resolved (even to "none"): unlike model weights, missing or
// unreachable metadata is not an error -- it just means the language-fit check stays off.
async function ensureLanguages(model: string): Promise<void> {
  if (existsSync(languagesPath(model))) return;
  // A measured entry needs no card and no network, and stays deterministic offline.
  const measured = MEASURED_MODEL_LANGUAGES[model];
  if (measured) {
    writeLanguages(model, measured);
    return;
  }
  let res: Response;
  try {
    res = await fetchWithRetry(`https://huggingface.co/api/models/${model}`, {});
  } catch {
    return;
  }
  if (!res.ok) return;
  let info: HfModelInfo;
  try {
    info = (await res.json()) as HfModelInfo;
  } catch {
    return;
  }
  writeLanguages(model, languagesFromCard(info) ?? []);
}

async function fetchToFile(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetchWithRetry(url, {});
  } catch (err) {
    throw new SenseError('EMBED_MODEL', `could not reach ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new SenseError('EMBED_MODEL', `${url} -> HTTP ${res.status}`);
  writeFileAtomic(dest, Buffer.from(await res.arrayBuffer()));
}

// Fetches an already-known sha straight into its snapshot dir, without touching refs/main --
// for downloadModel below, and for callers pinning an exact revision (the parity suite).
export async function downloadModelRevision(model: string, sha: string, onFile?: (file: string, dir: string) => void): Promise<string> {
  const dir = snapshotDir(model, sha);
  mkdirSync(dir, { recursive: true });
  for (const file of MODEL_FILES) {
    if (existsSync(join(dir, file))) continue;
    onFile?.(file, dir);
    await fetchToFile(`https://huggingface.co/${model}/resolve/${sha}/${file}`, join(dir, file));
  }
  return dir;
}

// The only code path that resolves `main`: a static provider's first construction calls it
// lazily, `sense download` as an explicit prefetch. Idempotent either way.
export async function downloadModel(model: string, onFile?: (file: string, dir: string) => void): Promise<string> {
  if (!isDownloadable(model)) {
    throw new SenseError('EMBED_MODEL', `embed.model "${model}" is a local path, not a Hugging Face model id, so there is nothing to download; put model.safetensors and tokenizer.json in that directory, or name a model id like "minishlab/potion-retrieval-32M"`);
  }
  const sha = await resolveSha(model);
  // Independent of the weights above: a fresh HEAD/GET pair either way, so a lazy first
  // construction and an explicit prefetch both end up with a cached language verdict.
  await ensureLanguages(model);
  return downloadModelRevision(model, sha, onFile);
}
