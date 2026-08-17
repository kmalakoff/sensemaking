import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, runSql } from './shared.ts';
import type { Command } from './types.ts';

const query: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.query}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...FORMAT, ...CONFIG });
  const [sql, ...params] = positionals;
  if (!sql) ctx.usageError(usage);
  const format = formatOf(values);
  runSql(ctx.resolveConfig(values.config as string | undefined), sql, params, format, 'ad-hoc query');
};
export default query;
