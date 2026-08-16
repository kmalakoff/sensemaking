import { search } from '../commands.ts';
import { printRows } from '../output.ts';
import { parseK, runSql, withDb } from './shared.ts';
import type { Ctx } from './types.ts';

// Fallback when the first positional is not a command: a named query from config, either a
// SQL string (run as-is) or a saved search (run through the `search` command's own machinery).
export default async function named(ctx: Ctx, queryName: string, params: string[]): Promise<void> {
  const cfg = ctx.resolveConfig();
  const entry = cfg.queries[queryName];
  if (entry === undefined) {
    console.error(`unknown query: "${queryName}"`);
    console.error(`valid queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
    process.exit(2);
  }

  if (typeof entry === 'string') {
    runSql(cfg, entry, params, ctx.format, `query "${queryName}"`);
    return;
  }
  if ('sql' in entry) {
    runSql(cfg, entry.sql, params, ctx.format, `query "${queryName}"`);
    return;
  }

  // A saved search's text is fixed in config; there is nowhere for a positional to bind.
  if (params.length > 0) {
    ctx.usageError(`"${queryName}" is a saved search and takes no positional parameters; edit its "search" in sense.config.json, or use "${ctx.name} search" directly`);
  }
  const k = parseK(ctx) ?? entry.k;
  const where = ctx.values.where ?? entry.where;
  const preset = ctx.values.preset ?? entry.preset;
  const include = ctx.values.include ?? entry.include;
  // --lexical upgrades a saved search's semantic behavior the same way --where/--k
  // override; absent means the saved value (the flag has no default false override).
  const semantic = ctx.values.lexical ? false : entry.semantic;
  await withDb(ctx, async (db, resolvedCfg) => printRows(await search(db, resolvedCfg, entry.search, { k, where, preset, include, semantic }), ctx.format));
}
