import { globSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Config } from '../config/index.ts';
import { embedEnabled, presetHasSignal, presetNames } from '../config/index.ts';

export interface FileStat {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  ctimeMs: number; // filesystem birthtime; a clone or copy resets it, like _mtime
  size: number;
  presets: string[]; // every declared preset covering this file (>= 1; union, overlap allowed)
  embed: boolean; // true iff a model is named and some covering preset's signals include vectors
}

// Presets are views, not partitions: they overlap freely, and a file's covering set (not one
// owner) drives indexing. Globs resolve relative to baseDir; unmatched files are not indexed.
export function toPosixPath(relPath: string, separator: string = sep): string {
  return separator === '\\' ? relPath.split(separator).join('/') : relPath;
}

// Every command pays listFiles before it answers (the freshness check stats each file), so
// per-file work here is the hottest path in the package. Everything derivable from the config
// alone is computed once, above the loop.
const NO_THROW = { throwIfNoEntry: false } as const;

export function listFiles(cfg: Config, baseDir: string): FileStat[] {
  const coverage = new Map<string, Set<string>>();
  const posixNeeded = sep === '\\';
  for (const name of presetNames(cfg)) {
    const preset = cfg.presets[name];
    for (const matched of globSync(preset.include, { cwd: baseDir, exclude: preset.exclude })) {
      const relPath = posixNeeded ? toPosixPath(matched) : matched;
      const set = coverage.get(relPath) ?? new Set<string>();
      set.add(name);
      coverage.set(relPath, set);
    }
  }

  // Which presets want vectors is a property of the config, not of any file.
  const embedding = embedEnabled(cfg);
  const vectorPresets = embedding ? new Set(presetNames(cfg).filter((name) => presetHasSignal(cfg, name, 'vectors'))) : null;

  const files: FileStat[] = [];
  for (const relPath of [...coverage.keys()].sort()) {
    const absPath = join(baseDir, relPath); // join re-applies the platform separator for fs calls
    // node:fs glob matches directories and dangling symlinks; fast-glob returned neither, so
    // one stat filters both back out (throwIfNoEntry keeps a dangling link from throwing).
    const st = statSync(absPath, NO_THROW);
    if (!st?.isFile()) continue;
    const presets = [...(coverage.get(relPath) as Set<string>)].sort();
    const embed = vectorPresets !== null && presets.some((name) => vectorPresets.has(name));
    files.push({ relPath, absPath, mtimeMs: st.mtimeMs, ctimeMs: st.birthtimeMs, size: st.size, presets, embed });
  }
  return files;
}
