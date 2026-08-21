import { search } from '../commands.ts';
import { printRows } from '../output.ts';
import { CONFIG, FORMAT, formatOf, parse, parseK, runSql, SEARCH_FLAGS, withDb } from './shared.ts';
import type { Ctx } from './types.ts';

// Fallback when the first positional is not a command: a saved query, { sql } or { search }.
// SEARCH_FLAGS override a saved search's fields the same way they override a preset's.
export default async function named(ctx: Ctx, queryName: string): Promise<void> {
  const usage = `usage: ${ctx.name} ${queryName} [params...] [--format table|json] [--config path] [--where "<sql>"] [--k n] [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude]`;
  const { values, positionals: params } = parse(ctx.argv, usage, { ...SEARCH_FLAGS, ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  const configPath = values.config as string | undefined;

  const cfg = ctx.resolveConfig(configPath);
  const entry = cfg.queries[queryName];
  if (entry === undefined) {
    console.error(`unknown command or saved entry: "${queryName}"`);
    console.error(`saved queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
    process.exit(2);
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
  const exclude = (values.exclude as string[] | undefined) ?? entry.exclude;
  const noExclude = values['no-exclude'] === true;
  await withDb(ctx, configPath, async (db, resolvedCfg) => printRows(await search(db, resolvedCfg, entry.search, { k, where, preset, include, exclude, noExclude }), format));
}
