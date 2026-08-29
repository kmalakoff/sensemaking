import { readFileSync } from 'node:fs';
import { parse } from '../chunk/index.ts';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import { textFromBlocks } from '../text/strip.ts';
import { looksLikeDatetime, mapValue, normalizeText, parseFrontmatter, RESERVED_COLUMNS, splitFrontmatter } from './frontmatter.ts';
import type { FileStat } from './list.ts';

// Filesystem -> rows. Pure data in, data + warnings out; store/sqlite/reconcile.ts does the SQL.

export { looksLikeDatetime, normalizeDate, RESERVED_COLUMNS } from './frontmatter.ts';
export type { FileStat } from './list.ts';
export { listFiles, toPosixPath } from './list.ts';

export interface ParsedDoc {
  relPath: string;
  mtimeMs: number;
  ctimeMs: number;
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

export function parseFile(file: FileStat, extractors: Feature[] = [], cfg?: Config): { doc: ParsedDoc; warnings: string[] } {
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

  // Parsed once and shared: the FTS text path (textFromBlocks, ~ strip.ts) and any feature
  // that needs a parse tree (embed's chunker) both read this same block list.
  const blocks = parse(content);

  // title/summary are plain YAML strings -- whitespace-collapse only;
  // the prose gets the full markdown strip.
  const search = { title: normalizeText(data.title), summary: normalizeText(data.summary), text: textFromBlocks(blocks) };

  return {
    doc: {
      relPath: file.relPath,
      mtimeMs: file.mtimeMs,
      ctimeMs: file.ctimeMs,
      size: file.size,
      presets: file.presets,
      data: mapped,
      parseError,
      search,
      extracted: Object.fromEntries(extractors.filter((f) => f.extract).map((f) => [f.name, f.extract?.(raw, content, search, data, cfg, blocks)])),
    },
    warnings,
  };
}
