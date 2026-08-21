import { mapTree } from '../commands.ts';
import { renderMap } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, SCOPE, withDb } from './shared.ts';
import type { Command } from './types.ts';

const map: Command = (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.map}`, { ...SCOPE, ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, (db, cfg) => {
    const result = mapTree(db, cfg, { where: values.where as string | undefined, preset: values.preset as string | undefined, include: values.include as string[] | undefined, exclude: values.exclude as string[] | undefined });
    console.log(format === 'json' ? JSON.stringify(result, null, 2) : renderMap(result));
  });
};
export default map;
