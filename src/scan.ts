import { globSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import removeMarkdown from 'remove-markdown';
import { parseDocument } from 'yaml';
import type { Config } from './config.ts';
import { embedEnabled, presetNames, presetSemanticEnabled } from './config.ts';
import type { Feature } from './features/types.ts';

// Filesystem -> rows. Pure data in, data + warnings out; db.ts does the SQL.

// Frontmatter keys that would collide with table columns. Exported so db.ts's upsert can tell
// a feature-owned column (`_rank`) from a parsed one and leave it alone on reparse.
export const RESERVED_COLUMNS = new Set(['path', '_mtime', '_size', '_rank', 'content', 'links', 'sections']);

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// Keeps URL query strings, asset filenames, and HTML attributes out of the index: rare terms
// carry high IDF, so they outrank prose. remove-markdown misses wikilinks and tables.
function stripText(value: string): string {
  const withoutWikilinks = value.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1');
  const withoutMarkdown = removeMarkdown(withoutWikilinks);
  const withoutTables = withoutMarkdown.replace(/^\s*\|?[-\s|:]+\|\s*$/gm, '').replace(/\|/g, ' ');
  return normalizeText(withoutTables);
}

export interface FileStat {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  presets: string[]; // every declared preset covering this file (>= 1; union, overlap allowed)
  embed: boolean; // true iff a model is named and some covering preset has semantic on
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
  const semanticPresets = embedding ? new Set(presetNames(cfg).filter((name) => presetSemanticEnabled(cfg, name))) : null;

  const files: FileStat[] = [];
  for (const relPath of [...coverage.keys()].sort()) {
    const absPath = join(baseDir, relPath); // join re-applies the platform separator for fs calls
    // node:fs glob matches directories and dangling symlinks; fast-glob returned neither, so
    // one stat filters both back out (throwIfNoEntry keeps a dangling link from throwing).
    const st = statSync(absPath, NO_THROW);
    if (!st?.isFile()) continue;
    const presets = [...(coverage.get(relPath) as Set<string>)].sort();
    const embed = semanticPresets !== null && presets.some((name) => semanticPresets.has(name));
    files.push({ relPath, absPath, mtimeMs: st.mtimeMs, size: st.size, presets, embed });
  }
  return files;
}

export interface ParsedDoc {
  relPath: string;
  mtimeMs: number;
  size: number;
  presets: string[];
  data: Record<string, string | number | bigint | null>;
  // title/summary are duplicated from frontmatter so bm25() can weight them above the body text.
  search: { title: string; summary: string; text: string };
  // Per-feature extraction results, keyed by feature name; features store them at reconcile.
  extracted: Record<string, unknown>;
}

// Storage class follows the YAML scalar. Booleans store as 1/0, so `WHERE flag = 1` matches
// and `WHERE flag = 'true'` cannot; `map` prints observed types so the mismatch is visible.
function mapValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return BigInt(value ? 1 : 0);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// The delimiter split is all this package used gray-matter for.
function splitFrontmatter(raw: string): { fm: string | null; body: string } {
  const open = raw.match(/^---\r?\n/);
  if (!open) return { fm: null, body: raw };
  const rest = raw.slice(open[0].length);
  const close = rest.match(/^---\r?(\n|$)/m);
  if (!close || close.index === undefined) return { fm: null, body: raw };
  return { fm: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

// Lenient by design: parseDocument collects syntax errors as data and still yields values,
// so Obsidian-style frontmatter (e.g. an alias starting with @) survives with a warning.
function parseFrontmatter(relPath: string, fm: string, warnings: string[]): Record<string, unknown> {
  const doc = parseDocument(fm);
  if (doc.errors.length > 0) {
    warnings.push(`warning: ${relPath} frontmatter has ${doc.errors.length} syntax error(s) (${doc.errors[0].message.split('\n')[0]}); parsed leniently`);
  }
  let data: unknown;
  try {
    data = doc.toJS();
  } catch (err) {
    warnings.push(`warning: ${relPath} has unparseable frontmatter (${(err as Error).message.split('\n')[0]}); indexing without it`);
    return {};
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    warnings.push(`warning: ${relPath} frontmatter is not a key-value mapping; ignoring it`);
    return {};
  }
  return data as Record<string, unknown>;
}

export function parseFile(file: FileStat, extractors: Feature[] = []): { doc: ParsedDoc; warnings: string[] } {
  const raw = readFileSync(file.absPath, 'utf8');
  const warnings: string[] = [];

  const { fm, body: content } = splitFrontmatter(raw);
  const data = fm === null ? {} : parseFrontmatter(file.relPath, fm, warnings);
  const mapped: Record<string, string | number | bigint | null> = {};

  for (const key of Object.keys(data)) {
    if (RESERVED_COLUMNS.has(key)) {
      warnings.push(`warning: ${file.relPath} has a frontmatter key named "${key}", which is reserved; ignoring it`);
      continue;
    }
    mapped[key] = mapValue(data[key]);
  }

  // title/summary are plain YAML strings -- whitespace-collapse only;
  // the prose gets the full markdown strip.
  const search = { title: normalizeText(data.title), summary: normalizeText(data.summary), text: stripText(content) };

  return {
    doc: {
      relPath: file.relPath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      presets: file.presets,
      data: mapped,
      search,
      extracted: Object.fromEntries(extractors.filter((f) => f.extract).map((f) => [f.name, f.extract?.(raw, content, search)])),
    },
    warnings,
  };
}
