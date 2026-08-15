import { runSql } from './shared.ts';
import type { Command } from './types.ts';

const query: Command = (ctx) => {
  const [sql, ...params] = ctx.rest;
  if (!sql) ctx.usageError(`usage: ${ctx.name} query "<sql>" [params...]`);
  runSql(ctx.resolveConfig(), sql, params, ctx.format, 'ad-hoc query');
};
export default query;
