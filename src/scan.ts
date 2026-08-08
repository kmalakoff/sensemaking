import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fastGlob from 'fast-glob';
import matter from 'gray-matter';
import type { Config } from './config.ts';

// Filesystem -> rows. Pure data in, data + warnings out -- no node:sqlite,
// no printing. db.ts is the only thing that knows what to do with the
// result (diffing against `docs`, writing SQL).

// Reserved `docs` columns: the real file path plus the mtime/size pair used
// to detect staleness. A frontmatter key literally named one of these would
// collide, so it's dropped (with a warning returned to the caller) rather
// than clobbering the column.
const RESERVED_COLUMNS = new Set(['path', '_mtime', '_size']);

export interface FileStat {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
}

// Glob the files `cfg.scan.include` matches under `baseDir`, stat each.
// Sorted for deterministic output.
export function listFiles(cfg: Config, baseDir: string): FileStat[] {
  const relPaths = fastGlob.sync(cfg.scan.include, { cwd: baseDir }).sort();
  return relPaths.map((relPath) => {
    const absPath = join(baseDir, relPath);
    const st = statSync(absPath);
    return { relPath, absPath, mtimeMs: st.mtimeMs, size: st.size };
  });
}

export interface ParsedDoc {
  relPath: string;
  mtimeMs: number;
  size: number;
  // Already value-mapped (booleans -> 0/1, dates -> ISO, arrays/objects ->
  // JSON text), reserved keys already dropped -- ready to bind into SQL.
  data: Record<string, string | number | null>;
}

// Value mapping: strings/numbers as-is; booleans -> 0/1; dates -> ISO
// strings (lexicographic = chronological, no date lib); arrays/objects ->
// JSON text. `null`/`undefined` map to SQL NULL.
function mapValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  // arrays and plain objects
  return JSON.stringify(value);
}

// Read + parse one file's frontmatter, mapping values and dropping reserved
// keys. Returns the parsed doc plus any warnings (e.g. a reserved key
// collision) for the caller to surface.
export function parseFile(file: FileStat): { doc: ParsedDoc; warnings: string[] } {
  const raw = readFileSync(file.absPath, 'utf8');
  const { data } = matter(raw);

  const warnings: string[] = [];
  const mapped: Record<string, string | number | null> = {};

  for (const key of Object.keys(data)) {
    if (RESERVED_COLUMNS.has(key)) {
      warnings.push(`warning: ${file.relPath} has a frontmatter key named "${key}", which is reserved; ignoring it`);
      continue;
    }
    mapped[key] = mapValue(data[key]);
  }

  return {
    doc: { relPath: file.relPath, mtimeMs: file.mtimeMs, size: file.size, data: mapped },
    warnings,
  };
}
