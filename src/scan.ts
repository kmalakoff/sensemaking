import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fastGlob from 'fast-glob';
import matter from 'gray-matter';
import removeMarkdown from 'remove-markdown';
import type { Config } from './config.ts';

// Filesystem -> rows. Pure data in, data + warnings out; db.ts does the SQL.

// Reserved: colliding with these would clash with the `frontmatter` table's own columns or the `content` FTS5 table.
const RESERVED_COLUMNS = new Set(['path', '_mtime', '_size', 'content']);

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
}

function mapValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return JSON.stringify(value);
}

export function parseFile(file: FileStat): { doc: ParsedDoc; warnings: string[] } {
  const raw = readFileSync(file.absPath, 'utf8');
  const { data, content } = matter(raw);

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
    },
    warnings,
  };
}
