import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fastGlob from 'fast-glob';
import removeMarkdown from 'remove-markdown';
import { parseDocument } from 'yaml';
import type { Config } from './config.ts';
import type { Feature } from './features/types.ts';

// Filesystem -> rows. Pure data in, data + warnings out; db.ts does the SQL.

// Reserved: colliding with these would clash with the `frontmatter` table's own columns or the other tables (`content`, `links`, `sections`).
const RESERVED_COLUMNS = new Set(['path', '_mtime', '_size', '_rank', 'content', 'links', 'sections']);

function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// Markdown is stripped at index time so snippets read as clean prose (also improves matching, e.g. `**bold**` indexes as `bold`).
// remove-markdown doesn't cover Obsidian wikilinks or table scaffolding, so those are handled first/after.
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
}

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
  data: Record<string, string | number | null>;
  // title/summary are duplicated from frontmatter so bm25() can weight them above the body text.
  search: { title: string; summary: string; text: string };
  // Per-feature extraction results, keyed by feature name; features store them at reconcile.
  extracted: Record<string, unknown>;
}

function mapValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
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
  const mapped: Record<string, string | number | null> = {};

  for (const key of Object.keys(data)) {
    if (RESERVED_COLUMNS.has(key)) {
      warnings.push(`warning: ${file.relPath} has a frontmatter key named "${key}", which is reserved; ignoring it`);
      continue;
    }
    mapped[key] = mapValue(data[key]);
  }

  return {
    doc: {
      relPath: file.relPath,
      mtimeMs: file.mtimeMs,
      size: file.size,
      data: mapped,
      search: {
        // title/summary are plain YAML strings -- whitespace-collapse only;
        // the prose gets the full markdown strip.
        title: normalizeText(data.title),
        summary: normalizeText(data.summary),
        text: stripText(content),
      },
      extracted: Object.fromEntries(extractors.filter((f) => f.extract).map((f) => [f.name, f.extract?.(raw, content)])),
    },
    warnings,
  };
}
