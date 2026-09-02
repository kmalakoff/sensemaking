// A corpus tree copy that keeps the pinned cache entry read-only: every write a measurement
// makes (.sense, sense.config.json, touched mtimes) lands in the copy, never in .tmp/cache.
import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

// Same shape across every OS: cpSync's filter receives whatever separator the platform uses.
const EXCLUDE = /[/\\](\.sense|\.git|\.obsidian|node_modules)([/\\]|$)/;

// preserveTimestamps: cpSync's default re-stamps every file to the copy time, which would make
// two separate captures of an unchanged corpus (store-dump.mjs's before/after workflow) always
// disagree on _mtime. Preserving the source's real mtimes keeps that comparison meaningful.
export function copyTree(source, dest) {
  cpSync(source, dest, { recursive: true, preserveTimestamps: true, filter: (src) => !EXCLUDE.test(src) });
}

// A private copy used for one run and discarded (run.mjs, store-dump.mjs capture): the caller
// removes it with safeRmSync when done.
export function ephemeralWorkTree(tmpRoot, prefix, source) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, prefix));
  copyTree(source, dir);
  return dir;
}

// A private copy built once and left in place so a later run reuses its index instead of
// rebuilding it (eval.mjs): keyed by name under workRoot, never touched again once it exists.
export function stableWorkTree(workRoot, key, source) {
  const dir = join(workRoot, key);
  if (!existsSync(dir)) {
    mkdirSync(workRoot, { recursive: true });
    copyTree(source, dir);
  }
  return dir;
}
