import { search } from '../commands.ts';
import { printRows } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, parseK, SEARCH_FLAGS, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const searchCmd: Command = async (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.search}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SEARCH_FLAGS, ...FORMAT, ...CONFIG });
  const [terms] = positionals;
  if (!terms) ctx.usageError(usage);
  const k = parseK(values.k as string | undefined, ctx.usageError);
  const format = formatOf(values);
  await withDb(ctx, values.config as string | undefined, async (db, cfg) => printRows(await search(db, cfg, terms, { k, ...scopeOf(values) }), format));
};
export default searchCmd;
