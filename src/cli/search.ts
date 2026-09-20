import { scopedPaths } from '../commands/scope.ts';
import { search } from '../commands/search.ts';
import { resolveSearch } from '../config/index.ts';
import { printRows } from '../output/output.ts';
import { type BuildRequirement, prepareDocumentEmbeddings } from '../store/open.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, NO_BUILD, parse, parseK, parseSnippetCharLimit, parseSnippetCountLimit, rowFormatOf, SEARCH_FLAGS, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const searchCmd: Command = async (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.search}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SEARCH_FLAGS, ...NO_BUILD, ...FORMAT, ...CONFIG });
  const [terms] = positionals;
  if (!terms) ctx.usageError(usage);
  const k = parseK(values.k as string | undefined, ctx.usageError);
  const snippetCharLimit = parseSnippetCharLimit(values['snippet-char-limit'] as string | undefined, ctx.usageError);
  const snippetCountLimit = parseSnippetCountLimit(values['snippet-count-limit'] as string | undefined, ctx.usageError);
  const format = rowFormatOf(values);
  const overrides = { k, snippetCharLimit, snippetCountLimit, ...scopeOf(values) };
  const noBuild = values['no-build'] === true;
  await withDb(
    ctx,
    values.config as string | undefined,
    {
      noBuild,
      requirements: (cfg) => {
        const signals = resolveSearch(cfg, overrides).signals;
        const requirements = new Set<BuildRequirement>(['core']);
        if (signals.words !== undefined) requirements.add('lexical');
        return requirements;
      },
    },
    async (store, cfg, build) => {
      if (build && resolveSearch(cfg, overrides).signals.vectors !== undefined) {
        await prepareDocumentEmbeddings(store, cfg, await scopedPaths(store, cfg, overrides));
      }
      printRows(await search(store, cfg, terms, overrides), format);
    }
  );
};
export default searchCmd;
