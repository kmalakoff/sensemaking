import { scopedPaths } from '../commands/scope.ts';
import { search } from '../commands/search.ts';
import { resolveSearch } from '../config/index.ts';
import { printRows } from '../output/output.ts';
import { type BuildRequirement, prepareDocumentEmbeddings } from '../store/open.ts';
import { CONFIG, FORMAT, NO_BUILD, parse, parseK, parseSnippetCharLimit, parseSnippetCountLimit, rowFormatOf, runSql, SEARCH_FLAGS, withResolvedDb } from './shared.ts';
import type { Ctx } from './types.ts';

// Fallback when the first positional is not a command: a saved query, { sql } or { search }.
// SEARCH_FLAGS override a saved search's fields the same way they override a preset's.
export default async function named(ctx: Ctx, queryName: string): Promise<void> {
  const usage = `usage: ${ctx.name} ${queryName} [params...] [--format table|json|csv] [--config path] [--where "<sql>"] [--k n] [--snippet-char-limit n] [--snippet-count-limit n] [--preset name] [--include glob ...] [--exclude glob ...] [--no-exclude] [--no-build]`;
  const { values, positionals: params } = parse(ctx.argv, usage, { ...SEARCH_FLAGS, ...NO_BUILD, ...FORMAT, ...CONFIG });
  const format = rowFormatOf(values);
  const configPath = values.config as string | undefined;
  const noBuild = values['no-build'] === true;

  const cfg = ctx.resolveConfig(configPath, { writeMigration: !noBuild, query: true });
  const entry = cfg.queries[queryName];
  if (entry === undefined) {
    console.error(`unknown command or saved entry: "${queryName}"`);
    console.error(`saved queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
    process.exit(2);
  }

  if ('sql' in entry) {
    // A saved statement written against `scope` is preset-agnostic, so the same entry can be
    // re-pointed at another layer from the command line instead of being copied per preset.
    await runSql(cfg, entry.sql, params, format, `query "${queryName}"`, noBuild, values.preset as string | undefined);
    return;
  }

  // A saved search's text is fixed in config; there is nowhere for a positional to bind.
  if (params.length > 0) {
    ctx.usageError(`"${queryName}" is a saved search and takes no positional parameters; edit its "search" in sense.config.json, or use "${ctx.name} search" directly`);
  }
  const k = parseK(values.k as string | undefined, ctx.usageError) ?? entry.k;
  const snippetCharLimit = parseSnippetCharLimit(values['snippet-char-limit'] as string | undefined, ctx.usageError);
  const snippetCountLimit = parseSnippetCountLimit(values['snippet-count-limit'] as string | undefined, ctx.usageError);
  const where = (values.where as string | undefined) ?? entry.where;
  const preset = (values.preset as string | undefined) ?? entry.preset;
  const include = (values.include as string[] | undefined) ?? entry.include;
  const exclude = (values.exclude as string[] | undefined) ?? entry.exclude;
  const noExclude = values['no-exclude'] === true;
  const overrides = { k, snippetCharLimit, snippetCountLimit, where, preset, include, exclude, noExclude };
  await withResolvedDb(
    cfg,
    {
      noBuild,
      requirements: (resolvedCfg) => {
        const signals = resolveSearch(resolvedCfg, overrides).signals;
        const requirements = new Set<BuildRequirement>(['core']);
        if (signals.words !== undefined) requirements.add('lexical');
        return requirements;
      },
    },
    async (store, resolvedCfg, build) => {
      if (build && resolveSearch(resolvedCfg, overrides).signals.vectors !== undefined) {
        await prepareDocumentEmbeddings(store, resolvedCfg, await scopedPaths(store, resolvedCfg, overrides));
      }
      printRows(await search(store, resolvedCfg, entry.search, overrides), format);
    }
  );
}
