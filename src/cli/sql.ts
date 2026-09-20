import { USAGE } from './index.ts';
import { CONFIG, FORMAT, NO_BUILD, parse, rowFormatOf, runSql } from './shared.ts';
import type { Command } from './types.ts';

const sqlCmd: Command = async (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.sql}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...NO_BUILD, ...FORMAT, ...CONFIG, preset: { type: 'string' } });
  const [sql, ...params] = positionals;
  if (!sql) ctx.usageError(usage);
  const format = rowFormatOf(values);
  const noBuild = values['no-build'] === true;
  const cfg = ctx.resolveConfig(values.config as string | undefined, { writeMigration: !noBuild, query: true });
  await runSql(cfg, sql, params, format, 'ad-hoc statement', noBuild, values.preset as string | undefined);
};
export default sqlCmd;
