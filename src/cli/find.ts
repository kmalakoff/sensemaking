import { find } from '../commands.ts';
import { printRows } from '../output.ts';
import { parseK, withDb } from './shared.ts';
import type { Command } from './types.ts';

const findCmd: Command = async (ctx) => {
  const [terms] = ctx.rest;
  if (!terms) ctx.usageError(`usage: ${ctx.name} find "<terms>" [--where "<sql>"] [--k n] [--semantic]`);
  const k = parseK(ctx);
  await withDb(ctx, async (db, cfg) => printRows(await find(db, cfg, terms, { k, where: ctx.values.where, semantic: ctx.values.semantic }), ctx.format));
};
export default findCmd;
