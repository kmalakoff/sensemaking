import { buildIndex } from '../store/index.ts';
import { USAGE } from './index.ts';
import { CONFIG, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

const build: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.build}`, { force: { type: 'boolean', default: false }, ...CONFIG });
  const result = await buildIndex(ctx.resolveConfig(values.config as string | undefined), { force: values.force === true });
  printWarnings(result.warnings);
  console.log(`${ctx.name} build: ${result.parsed} file(s) parsed; index ready at ${result.dbPath}`);
};

export default build;
