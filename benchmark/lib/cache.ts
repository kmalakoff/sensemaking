// Fetch-once cache under .cache/ (gitignored). An entry something writes into after it is built stays in .cache/, one copy per checkout.
// .cache/shared holds only entries named by their content, renamed into place and never written to afterwards; every worktree reads one copy.
// An entry is built once per key, verified, and renamed into place by staged-cache, so an interrupted fetch leaves no entry that looks done.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stagedCache, verifySha256 } from 'staged-cache';
import { canonicalJson } from './canonical-json.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(ROOT, '.cache');
export const SHARED_CACHE_DIR = join(CACHE_DIR, 'shared');
export const cachePath = (key: string, cacheDir = CACHE_DIR) => join(cacheDir, key);

// Name plus the first 12 hex of the sha256 of the canonical spec: the key changes whenever anything that shapes the content does.
export const contentKey = (name: string, spec: object) =>
  `${name}-${createHash('sha256')
    .update(canonicalJson(spec as Record<string, unknown>))
    .digest('hex')
    .slice(0, 12)}`;

// Downloads url to file and refuses it unless its sha256 equals the recorded value; a refused file is removed.
export async function downloadVerified(url: string, file: string, sha256: string) {
  execFileSync('curl', ['-fsSL', '-o', file, url], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (!(await promisify(verifySha256(sha256))(file))) {
    rmSync(file, { force: true });
    throw new Error(`sha256 of ${url} does not match the recorded ${sha256}`);
  }
}

export interface CacheEntry {
  build: (staging: string) => void | Promise<void>;
  // True when the folder holds the complete entry; the caller knows what complete means for its key.
  verify: (dir: string) => boolean | Promise<boolean>;
}

export function cached(key: string, { build, verify }: CacheEntry, cacheDir = CACHE_DIR): Promise<string> {
  return stagedCache(cachePath(key, cacheDir), {
    verify: async (dir) => existsSync(dir) && (await verify(dir)),
    build: async (staging) => {
      console.error(`building ${key} into ${relative(ROOT, cacheDir)} (once; delete the entry to rebuild)`);
      mkdirSync(staging, { recursive: true }); // builders write into an existing folder
      await build(staging);
    },
  });
}

export function releaseComplete(dir: string, version: unknown) {
  const manifest = join(dir, 'node_modules', 'sensemaking', 'package.json');
  return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).version === version && existsSync(join(dir, 'node_modules', 'sensemaking', 'dist', 'esm', 'index.js'));
}

// The npm-installed release a comparison measures against; one key, so compare-versions and store-dump-ab share the install.
// Named by version and only read afterwards, so it is shared across worktrees.
export function cachedRelease(version: unknown): Promise<string> {
  return cached(
    `sensemaking-${version}`,
    {
      build(staging) {
        writeFileSync(join(staging, 'package.json'), '{"name":"bench","private":true}'); // stop npm walking up
        const install = spawnSync('npm', ['install', `sensemaking@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', staging], { cwd: staging, encoding: 'utf8' });
        if (install.status !== 0) throw new Error(`npm install sensemaking@${version} failed:\n${install.stderr}`);
      },
      verify: (dir) => releaseComplete(dir, version),
    },
    SHARED_CACHE_DIR
  );
}
