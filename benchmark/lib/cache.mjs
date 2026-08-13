// Fetch-once cache under .tmp/cache (gitignored): an entry is built exactly once per key
// and lives until .tmp is deleted. Builds are atomic — staged in <key>.building, renamed
// on success — so an interrupted fetch never leaves a half-built entry that looks done.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(ROOT, '.tmp', 'cache');

export function cached(key, build) {
  const dest = join(CACHE_DIR, key);
  if (existsSync(dest)) return dest;
  const staging = `${dest}.building`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  console.error(`building ${key} into .tmp/cache (once; delete .tmp to rebuild)`);
  build(staging);
  renameSync(staging, dest);
  return dest;
}
