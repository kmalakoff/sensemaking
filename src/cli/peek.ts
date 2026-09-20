import { peek } from '../commands/peek.ts';
import { renderPeek, stringifyJson } from '../output/output.ts';
import type { BuildRequirement } from '../store/open.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, NO_BUILD, parse, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const peekCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.peek}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...NO_BUILD, ...FORMAT, ...CONFIG });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, { noBuild: values['no-build'] === true, requirements: new Set<BuildRequirement>(['core']) }, async (store, cfg) => {
    const overrides = scopeOf(values);
    const result = await peek(store, cfg, pathArg, overrides);
    console.log(format === 'json' ? stringifyJson(result, 2) : renderPeek(result));
  });
};
export default peekCmd;
