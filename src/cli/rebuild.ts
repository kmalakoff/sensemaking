import { docCount, rebuild } from '../db.ts';
import { USAGE } from './index.ts';
import { CONFIG, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

const rebuildCmd: Command = (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.rebuild}`, { ...CONFIG });
  const result = rebuild(ctx.resolveConfig(values.config as string | undefined));
  printWarnings(result.warnings);
  console.log(`rebuilt: ${docCount(result.db)} docs`);
  result.db.close();
};
export default rebuildCmd;
