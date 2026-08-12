import { docCount, rebuild } from '../db.ts';
import type { Command } from './types.ts';
import { printWarnings } from './vault.ts';

const rebuildCmd: Command = (ctx) => {
  const result = rebuild(ctx.resolveConfig());
  printWarnings(result.warnings);
  console.log(`rebuilt: ${docCount(result.db)} docs`);
  result.db.close();
};
export default rebuildCmd;
