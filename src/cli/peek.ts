import { peek } from '../commands/peek.ts';
import { renderPeek, stringifyJson } from '../output/output.ts';
import type { BuildRequirement } from '../store/open.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, NO_BUILD, parse, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

function parseCountLimit(name: string, value: string | undefined, usageError: (message: string) => never): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) usageError(`--${name} expects a positive safe integer, got "${value}"`);
  return parsed;
}

const peekCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.peek}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...NO_BUILD, ...FORMAT, ...CONFIG, 'section-count-limit': { type: 'string' }, 'link-count-limit': { type: 'string' } });
  const [pathArg] = positionals;
  if (!pathArg) ctx.usageError(usage);
  const sectionCountLimit = parseCountLimit('section-count-limit', values['section-count-limit'] as string | undefined, ctx.usageError);
  const linkCountLimit = parseCountLimit('link-count-limit', values['link-count-limit'] as string | undefined, ctx.usageError);
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, { noBuild: values['no-build'] === true, requirements: new Set<BuildRequirement>(['core']) }, async (store, cfg) => {
    const overrides = { ...scopeOf(values), sectionCountLimit, linkCountLimit };
    const result = await peek(store, cfg, pathArg, overrides);
    console.log(format === 'json' ? stringifyJson(result, 2) : renderPeek(result));
  });
};
export default peekCmd;
