import { globSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import removeMarkdown from 'remove-markdown';
import { isCollection, parseDocument, visit } from 'yaml';
import type { Config } from './config.ts';
import { embedEnabled, presetNames, presetSemanticEnabled } from './config.ts';
import type { Feature } from './features/types.ts';

// Filesystem -> rows. Pure data in, data + warnings out; db.ts does the SQL.

// Frontmatter keys that would collide with table columns. Exported so db.ts's upsert can tell
// a feature-owned column (`_rank`) from a parsed one and leave it alone on reparse.
export const RESERVED_COLUMNS = new Set(['path', '_mtime', '_size', '_rank', '_parse_error', 'content', 'links', 'sections']);

// YAML error codes whose recovery is unambiguous, so the parse is accepted rather than
// quarantined. Only one qualifies: YAML 1.2 reserves `@` and `` ` `` at the start of a plain
// scalar for future use, so they can never be valid and the text can only be what was typed
// (`aliases: [@handle]` -> ["@handle"]). Every other code has a second reading -- an unquoted
// `:` swallows the keys after it, an unquoted `[..](..)` drops the URL, a duplicate key picks
// one value in silence -- so it writes values nobody wrote. See plans/frontmatter-parse-policy.md.
const ACCEPTED_YAML_CODES = new Set(['BAD_SCALAR_START']);

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
  // NULL when the frontmatter parsed, the first YAML message otherwise. In the row rather than
  // a side table so `SELECT *` and any `IS NULL` investigation trip over it without being asked.
  parseError: string | null;
  // title/summary are duplicated from frontmatter so bm25() can weight them above the body text.
  search: { title: string; summary: string; text: string };
  // Per-feature extraction results, keyed by feature name; features store them at reconcile.
  extracted: Record<string, unknown>;
}

// SQLite's datetime() rejects a colonless offset (`-0800`) and a space separator, which ISO 8601
// allows and producers emit. A rejected date is invisible, not excluded: every comparison is NULL.
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

// A value opening `YYYY-MM-DDT` was meant to be a datetime; prose never is. Reported when it
// cannot be normalized, so a typo surfaces on the next crawl instead of at some later audit.
const MEANT_AS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d/;

export function looksLikeDatetime(value: string): boolean {
  return MEANT_AS_DATETIME.test(value);
}

// Punctuation only, never a timezone conversion: the offset survives, so substr(d,1,10) is still
// the local date. A shape that is not a real instant is left as written, and stays auditable.
export function normalizeDate(value: string): string {
  const m = ISO_DATETIME.exec(value);
  if (m === null) return value;
  const [, date, time, zone] = m;
  const digits = zone === undefined || zone === 'Z' ? '' : zone.replace(':', '');
  const offset = digits === '' ? (zone ?? '') : digits.length === 3 ? `${digits}:00` : `${digits.slice(0, 3)}:${digits.slice(3)}`;
  const normalized = `${date}T${time}${offset}`;
  return Number.isNaN(Date.parse(normalized)) ? value : normalized;
}

// Storage class follows the YAML scalar. Booleans store as 1/0, so `WHERE flag = 1` matches
// and `WHERE flag = 'true'` cannot; `map` prints observed types so the mismatch is visible.
function mapValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return BigInt(value ? 1 : 0);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof value === 'string') return normalizeDate(value);
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

// A well-formed document can still hold a value nobody meant: `created: {{date}}` is valid
// YAML for a flow map used as a mapping key, so it raises no error and stores
// {"{ date }": null}. No error code can catch that, but yaml notices the stringified key, so
// this reports it with the path instead (yaml's own warning has none, fires once per document,
// and is what trains readers to discard stderr).
function warnStringifiedKeys(relPath: string, doc: ReturnType<typeof parseDocument>, warnings: string[]): void {
  let found = false;
  // Nested, not top level: `created: {{date}}` puts the collection key one level down, inside
  // the flow map that `{{...}}` parses as.
  visit(doc, {
    Pair(_key, pair) {
      if (!isCollection(pair.key)) return undefined;
      found = true;
      return visit.BREAK;
    },
  });
  // One per file: a template repeats the same mistake on every field it stamps.
  if (found) warnings.push(`warning: ${relPath} frontmatter has a key that is itself a list or mapping, stored as text; this is usually an unrendered template placeholder like {{date}}`);
}

// Accept a clean parse, and one whose every error is unambiguous (ACCEPTED_YAML_CODES).
// Anything else is quarantined: no frontmatter columns at all, and `_parse_error` carries the
// reason. Recovering it would write values nobody wrote, which is worse than absence because
// no query can see it. The file is still indexed -- content, links and sections never touch
// frontmatter -- so a broken note stays searchable while it is being hunted for.
// yaml's message continues onto a source excerpt, so the first line is the sentence -- minus
// the colon that introduced the part being dropped.
function firstLine(message: string): string {
  return message.split('\n')[0].replace(/:\s*$/, '');
}

function parseFrontmatter(relPath: string, fm: string, warnings: string[]): { data: Record<string, unknown>; parseError: string | null } {
  // logLevel silences yaml's own pathless warnings; warnStringifiedKeys re-reports the one
  // that carries information, with the file it came from.
  const doc = parseDocument(fm, { logLevel: 'silent' });
  const refused = doc.errors.filter((err) => !ACCEPTED_YAML_CODES.has(err.code));
  if (refused.length > 0) {
    const detail = refused.length > 1 ? ` (and ${refused.length - 1} more)` : '';
    const parseError = `${firstLine(refused[0].message)}${detail}`;
    warnings.push(`warning: ${relPath} frontmatter did not parse, so none of it is indexed: ${parseError}`);
    return { data: {}, parseError };
  }

  let data: unknown;
  try {
    data = doc.toJS();
  } catch (err) {
    // Reaches here with doc.errors empty: `title: **Bold**` parses, then opens an alias on
    // materialisation. An empty error list is not a successful parse.
    const parseError = firstLine((err as Error).message);
    warnings.push(`warning: ${relPath} frontmatter did not parse, so none of it is indexed: ${parseError}`);
    return { data: {}, parseError };
  }

  if (data === null || data === undefined) return { data: {}, parseError: null };
  if (typeof data !== 'object' || Array.isArray(data)) {
    const parseError = 'frontmatter is not a key-value mapping';
    warnings.push(`warning: ${relPath} ${parseError}; none of it is indexed`);
    return { data: {}, parseError };
  }
  warnStringifiedKeys(relPath, doc, warnings);
  return { data: data as Record<string, unknown>, parseError: null };
}

export function parseFile(file: FileStat, extractors: Feature[] = []): { doc: ParsedDoc; warnings: string[] } {
  const raw = readFileSync(file.absPath, 'utf8');
  const warnings: string[] = [];

  const { fm, body: content } = splitFrontmatter(raw);
  const { data, parseError } = fm === null ? { data: {} as Record<string, unknown>, parseError: null } : parseFrontmatter(file.relPath, fm, warnings);
  const mapped: Record<string, string | number | bigint | null> = {};

  for (const key of Object.keys(data)) {
    if (RESERVED_COLUMNS.has(key)) {
      warnings.push(`warning: ${file.relPath} has a frontmatter key named "${key}", which is reserved; ignoring it`);
      continue;
    }
    const value = mapValue(data[key]);
    if (typeof value === 'string' && looksLikeDatetime(value) && Number.isNaN(Date.parse(value))) {
      warnings.push(`warning: ${file.relPath}: ${key} is not a valid date (${value}), so it is invisible to every date comparison`);
    }
    mapped[key] = value;
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
      parseError,
      search,
      extracted: Object.fromEntries(extractors.filter((f) => f.extract).map((f) => [f.name, f.extract?.(raw, content, search)])),
    },
    warnings,
  };
}
