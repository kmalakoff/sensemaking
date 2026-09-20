import { mapTree } from '../commands/map.ts';
import { renderMap, stringifyJson } from '../output/output.ts';
import type { BuildRequirement } from '../store/open.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, NO_BUILD, parse, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

const map: Command = (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.map}`, { ...SCOPE, ...NO_BUILD, ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, { noBuild: values['no-build'] === true, requirements: new Set<BuildRequirement>(['core']) }, async (store, cfg) => {
    const result = await mapTree(store, cfg, scopeOf(values));
    console.log(format === 'json' ? stringifyJson(result, 2) : renderMap(result));
  });
};
export default map;
