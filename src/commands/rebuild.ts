import { docCount, rebuild } from '../db.ts';
import { printWarnings } from './shared.ts';
import type { Command } from './types.ts';

const rebuildCmd: Command = (ctx) => {
  const result = rebuild(ctx.resolveConfig());
  printWarnings(result.warnings);
  console.log(`rebuilt: ${docCount(result.db)} docs`);
  result.db.close();
};
export default rebuildCmd;
