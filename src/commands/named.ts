import type { Ctx } from './types.ts';
import { runSql } from './vault.ts';

// Fallback when the first positional is not a command: a named query from config.
export default function named(ctx: Ctx, queryName: string, params: string[]): void {
  const cfg = ctx.resolveConfig();
  const sql = cfg.queries[queryName];
  if (!sql) {
    console.error(`unknown query: "${queryName}"`);
    console.error(`valid queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
    process.exit(2);
  }
  runSql(cfg, sql, params, ctx.format, `query "${queryName}"`);
}
