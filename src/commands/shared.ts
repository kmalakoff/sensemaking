import type { ResolvedConfig } from '../config.ts';
import type { OpenResult } from '../db.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { searchError } from '../search-error.ts';
import type { Ctx } from './types.ts';

// Shared open-query-close envelope for commands that touch the tree.

export function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.warn(w);
}

export async function withDb(ctx: Ctx, fn: (db: OpenResult['db'], cfg: ResolvedConfig) => void | Promise<void>): Promise<void> {
  const cfg = ctx.resolveConfig();
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
