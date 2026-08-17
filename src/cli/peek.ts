import { peek } from '../commands.ts';
import { renderPeek } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, withDb } from './shared.ts';
import type { Command } from './types.ts';

const peekCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.peek}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...FORMAT, ...CONFIG });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, (db, cfg) => {
    const result = peek(db, cfg, pathArg);
    console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderPeek(result));
  });
};
export default peekCmd;
