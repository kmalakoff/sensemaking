import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';
import type { ResolvedConfig } from '../config.ts';
import type { OpenResult } from '../db.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { searchError } from '../search-error.ts';
import type { Ctx } from './types.ts';

// Spreadable option fragments -- one flag name keeps one meaning across every command's table.
export const FORMAT: ParseArgsOptionsConfig = { format: { type: 'string', default: 'table' } };
export const CONFIG: ParseArgsOptionsConfig = { config: { type: 'string' } };
// The scope vocabulary every scoped command shares: named preset, ad hoc include/exclude
// globs, a where SQL condition. search adds k and lexical on top.
export const SCOPE: ParseArgsOptionsConfig = {
  where: { type: 'string' },
  preset: { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
};
export const SEARCH_FLAGS: ParseArgsOptionsConfig = { ...SCOPE, k: { type: 'string' }, lexical: { type: 'boolean', default: false } };

type Values = Record<string, string | boolean | string[] | undefined>;

export function formatOf(values: Values): 'table' | 'json' {
  return values.format === 'json' ? 'json' : 'table';
}

// Per-command parseArgs: strict (a foreign flag exits 2), and every table gets --help for free.
export function parse(argv: string[], usage: string, options: ParseArgsOptionsConfig): { values: Values; positionals: string[] } {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', default: false, short: 'h' } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage);
    process.exit(2);
  }
  if (values.help) {
    console.log(usage);
    process.exit(0);
  }
  return { values, positionals };
}

// --k must be a positive integer: SQLite reads a bound LIMIT of -1 as "unlimited" and 0 as
// "nothing", and parseInt would silently truncate "5.9" -- all three are caller mistakes
// worth a usage error, matching the config-level SavedSearch validation.
export function parseK(k: string | undefined, usageError: (message: string) => never): number | undefined {
  if (k === undefined) return undefined;
  const parsed = Number(k);
  if (!Number.isInteger(parsed) || parsed <= 0) usageError(`--k expects a positive integer, got "${k}"`);
  return parsed;
}

// Shared open-query-close envelope for commands that touch the tree.

export function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.warn(w);
}

export async function withDb(ctx: Ctx, configPath: string | undefined, fn: (db: OpenResult['db'], cfg: ResolvedConfig) => void | Promise<void>): Promise<void> {
  const cfg = ctx.resolveConfig(configPath);
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  try {
    await fn(db, cfg);
  } finally {
    db.close();
  }
}

// An unbound `?` silently binds NULL, so mismatched param counts fail loudly instead.
export function runSql(cfg: ResolvedConfig, sql: string, params: string[], format: 'table' | 'json', label: string): void {
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  if (params.length !== placeholderCount) {
    console.error(`${label} expects ${placeholderCount} parameter(s), got ${params.length}`);
    process.exit(2);
  }
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  let rows: Row[];
  try {
    rows = db.prepare(sql).all(...params) as Row[];
  } catch (err) {
    db.close();
    // A saved query or ad-hoc SQL can carry `content MATCH ?` too, so the same FTS5
    // punctuation trap applies -- the bound parameters are the search terms there. SQL
    // without MATCH gets its error verbatim; search advice on a plain typo would mislead.
    if (/\bMATCH\b/i.test(sql)) throw searchError(err as Error, params.join(' '));
    throw err;
  }
  printRows(rows, format);
  db.close();
}
