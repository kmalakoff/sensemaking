import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-write.ts';

// HF cache layout, no network: ~/.sense/models/models--<org>--<name>/{refs/main,
// snapshots/<sha>/<files>}, files stored directly (hf_hub's blobs/symlinks layer skipped).

export const MODEL_FILES = ['model.safetensors', 'tokenizer.json'];
// The pair, for messages that name what a local model directory must contain.
export const MODEL_FILENAMES = MODEL_FILES.join(' and ');

// A Hugging Face repo id: one slash, HF's charset. Anything else is a path, used as one rather
// than resolved against the HF cache.
const HF_MODEL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

export function isDownloadable(model: string): boolean {
  return HF_MODEL_ID.test(model);
}

function repoDir(model: string): string {
  const [org, name] = model.split('/');
  return join(homedir(), '.sense', 'models', `models--${org}--${name}`);
}

export function refsMainPath(model: string): string {
  return join(repoDir(model), 'refs', 'main');
}

// What `main` last resolved to, read from disk -- no network. Undefined until some resolution
// (a download or an explicit prefetch) has written it once.
export function readRef(model: string): string | undefined {
  const p = refsMainPath(model);
  if (!existsSync(p)) return undefined;
  const sha = readFileSync(p, 'utf8').trim();
  return sha.length > 0 ? sha : undefined;
}

// A recorded ref pins until its snapshot directory is removed; nothing here re-resolves it.
export function writeRef(model: string, sha: string): void {
  mkdirSync(join(repoDir(model), 'refs'), { recursive: true });
  writeFileAtomic(refsMainPath(model), sha);
}

export function snapshotDir(model: string, sha: string): string {
  return join(repoDir(model), 'snapshots', sha);
}

// Languages describe the repo, not one weight snapshot, so this lives beside refs/, not
// inside a snapshot dir.
export function languagesPath(model: string): string {
  return join(repoDir(model), 'languages.json');
}

// undefined means "never resolved yet"; an empty array is a resolved fact (checked, none
// declared) and is cached the same way, so a languageless model is not re-fetched every run.
export function readLanguages(model: string): string[] | undefined {
  const p = languagesPath(model);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

export function writeLanguages(model: string, languages: string[]): void {
  mkdirSync(repoDir(model), { recursive: true });
  writeFileAtomic(languagesPath(model), JSON.stringify(languages));
}

// A local directory the caller manages, or the resolved snapshot once `main` is pinned; an HF
// id with no recorded ref yet has no known snapshot, so this names the (fileless) repo dir.
export function modelDir(model: string): string {
  if (!isDownloadable(model)) return model;
  const sha = readRef(model);
  return sha ? snapshotDir(model, sha) : repoDir(model);
}

// Both files, so an interrupted download reads as absent and the next one resumes it.
export function hasModelFiles(model: string): boolean {
  const dir = modelDir(model);
  return MODEL_FILES.every((file) => existsSync(join(dir, file)));
}

// Weight identity for the signature, no network: a HF id's resolved sha, or the two
// files' size+mtime for a local path. Undefined when nothing is known yet.
export function modelIdentity(model: string): string | undefined {
  if (isDownloadable(model)) return readRef(model);
  const dir = modelDir(model);
  const parts: string[] = [];
  for (const file of MODEL_FILES) {
    try {
      const st = statSync(join(dir, file));
      parts.push(`${st.size}:${Math.trunc(st.mtimeMs)}`);
    } catch {
      return undefined;
    }
  }
  return parts.join(',');
}
