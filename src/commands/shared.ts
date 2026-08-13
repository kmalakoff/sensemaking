import type { ResolvedConfig } from '../config.ts';
import type { OpenResult } from '../db.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import type { Ctx } from './types.ts';

// Shared open-query-close envelope for commands that touch the tree.

export function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.warn(w);
}

export function withDb(ctx: Ctx, fn: (db: OpenResult['db'], cfg: ResolvedConfig) => void): void {
  const cfg = ctx.resolveConfig();
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  try {
    fn(db, cfg);
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
  printRows(db.prepare(sql).all(...params) as Row[], format);
  db.close();
}
