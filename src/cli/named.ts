import { search } from '../commands.ts';
import { printRows } from '../output.ts';
import { CONFIG, FORMAT, formatOf, parse, parseK, runSql, SEARCH_FLAGS, withDb } from './shared.ts';
import type { Ctx } from './types.ts';

// Fallback when the first positional is not a command: a named query from config, either a
// SQL string (run as-is) or a saved search (run through the `search` command's own machinery).
// Flags cover both shapes -- SEARCH_FLAGS override a saved search's fields the same way they
// override a preset's.
export default async function named(ctx: Ctx, queryName: string): Promise<void> {
  const usage = `usage: ${ctx.name} ${queryName} [params...] [--format table|json] [--config path] [--where "<sql>"] [--k n] [--preset name] [--include glob ...] [--lexical]`;
  const { values, positionals: params } = parse(ctx.argv, usage, { ...SEARCH_FLAGS, ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  const configPath = values.config as string | undefined;

  const cfg = ctx.resolveConfig(configPath);
  const entry = cfg.queries[queryName];
  if (entry === undefined) {
    console.error(`unknown query: "${queryName}"`);
    console.error(`valid queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
    process.exit(2);
  }

  if (typeof entry === 'string') {
    runSql(cfg, entry, params, format, `query "${queryName}"`);
    return;
  }
  if ('sql' in entry) {
    runSql(cfg, entry.sql, params, format, `query "${queryName}"`);
    return;
  }

  // A saved search's text is fixed in config; there is nowhere for a positional to bind.
  if (params.length > 0) {
    ctx.usageError(`"${queryName}" is a saved search and takes no positional parameters; edit its "search" in sense.config.json, or use "${ctx.name} search" directly`);
  }
  const k = parseK(values.k as string | undefined, ctx.usageError) ?? entry.k;
  const where = (values.where as string | undefined) ?? entry.where;
  const preset = (values.preset as string | undefined) ?? entry.preset;
  const include = (values.include as string[] | undefined) ?? entry.include;
  // --lexical upgrades a saved search's semantic behavior the same way --where/--k
  // override; absent means the saved value (the flag has no default false override).
  const semantic = values.lexical ? false : entry.semantic;
  await withDb(ctx, configPath, async (db, resolvedCfg) => printRows(await search(db, resolvedCfg, entry.search, { k, where, preset, include, semantic }), format));
}
