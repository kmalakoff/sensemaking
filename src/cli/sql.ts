import { USAGE } from './index.ts';
import { CONFIG, FORMAT, parse, rowFormatOf, runSql } from './shared.ts';
import type { Command } from './types.ts';

const sqlCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.sql}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...FORMAT, ...CONFIG, preset: { type: 'string' } });
  const [sql, ...params] = positionals;
  if (!sql) ctx.usageError(usage);
  const format = rowFormatOf(values);
  runSql(ctx.resolveConfig(values.config as string | undefined), sql, params, format, 'ad-hoc statement', values.preset as string | undefined);
};
export default sqlCmd;
