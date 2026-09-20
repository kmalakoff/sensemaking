import { relatedNotes, resolveRelatedSeed } from '../commands/related.ts';
import { scopedPaths } from '../commands/scope.ts';
import { resolveSearch } from '../config/index.ts';
import type { Row } from '../output/output.ts';
import { printRows } from '../output/output.ts';
import { type BuildRequirement, prepareDocumentEmbeddings } from '../store/open.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, NO_BUILD, parse, parseK, rowFormatOf, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const RELATED_DEFAULT_K = 5;

const relatedCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.related}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...NO_BUILD, ...FORMAT, ...CONFIG, k: { type: 'string' } });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const k = parseK(values.k as string | undefined, ctx.usageError) ?? RELATED_DEFAULT_K;
  const format = rowFormatOf(values);
  const noBuild = values['no-build'] === true;
  return withDb(ctx, values.config as string | undefined, { noBuild, requirements: new Set<BuildRequirement>(['core']) }, async (store, cfg, build) => {
    const overrides = scopeOf(values);
    if (build && resolveSearch(cfg, overrides).signals.vectors !== undefined) {
      const path = await resolveRelatedSeed(store, pathArg);
      const allowed = await scopedPaths(store, cfg, overrides);
      await prepareDocumentEmbeddings(store, cfg, new Set([...allowed, path]));
    }
    printRows((await relatedNotes(store, cfg, pathArg, overrides, k)) as Row[], format);
  });
};
export default relatedCmd;
