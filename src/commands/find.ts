import { printRows } from '../output.ts';
import { find } from '../verbs.ts';
import { withDb } from './shared.ts';
import type { Command } from './types.ts';

const findCmd: Command = (ctx) => {
  const [terms] = ctx.rest;
  if (!terms) ctx.usageError(`usage: ${ctx.name} find "<terms>" [--where "<sql>"] [--k n]`);
  const k = ctx.values.k === undefined ? undefined : Number.parseInt(ctx.values.k, 10);
  if (ctx.values.k !== undefined && !Number.isInteger(k)) ctx.usageError(`--k expects an integer, got "${ctx.values.k}"`);
  withDb(ctx, (db, cfg) => printRows(find(db, cfg, terms, { k, where: ctx.values.where }), ctx.format));
};
export default findCmd;
