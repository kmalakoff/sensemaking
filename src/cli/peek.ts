import { peek } from '../commands.ts';
import { renderPeek } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const peekCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.peek}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...FORMAT, ...CONFIG });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, (db, cfg) => {
    const overrides = scopeOf(values);
    const result = peek(db, cfg, pathArg, overrides);
    console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderPeek(result));
  });
};
export default peekCmd;
