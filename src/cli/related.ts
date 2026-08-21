import { relatedNotes } from '../commands.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, parseK, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const RELATED_DEFAULT_K = 5;

const relatedCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.related}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...FORMAT, ...CONFIG, k: { type: 'string' } });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const k = parseK(values.k as string | undefined, ctx.usageError) ?? RELATED_DEFAULT_K;
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, async (db, cfg) => {
    const overrides = scopeOf(values);
    printRows((await relatedNotes(db, cfg, pathArg, overrides, k)) as Row[], format);
  });
};
export default relatedCmd;
