import { find } from '../commands.ts';
import { printRows } from '../output.ts';
import { parseK, runSql, withDb } from './shared.ts';
import type { Ctx } from './types.ts';

// Fallback when the first positional is not a command: a named query from config, either a
// SQL string (run as-is) or a saved find (run through the `find` command's own machinery).
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

  // A saved find's terms are fixed in config; there is nowhere for a positional to bind.
  if (params.length > 0) {
    ctx.usageError(`"${queryName}" is a saved find and takes no positional parameters; edit its "find" in sense.config.json, or use "${ctx.name} find" directly`);
  }
  const k = parseK(ctx) ?? entry.k;
  const where = ctx.values.where ?? entry.where;
  // --semantic upgrades a saved find the same way --where/--k override; absent means the
  // saved value (the flag has no default, so absent is distinguishable from false).
  const semantic = ctx.values.semantic === true || entry.semantic;
  await withDb(ctx, async (db, resolvedCfg) => printRows(await find(db, resolvedCfg, entry.find, { k, where, semantic }), ctx.format));
}
