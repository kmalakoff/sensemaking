import { search } from '../commands.ts';
import { printRows } from '../output.ts';
import { parseK, withDb } from './shared.ts';
import type { Command } from './types.ts';

const searchCmd: Command = async (ctx) => {
  const [terms] = ctx.rest;
  if (!terms) ctx.usageError(`usage: ${ctx.name} search "<terms>" [--preset name] [--include glob ...] [--where "<sql>"] [--k n] [--lexical]`);
  const k = parseK(ctx);
  await withDb(ctx, async (db, cfg) => printRows(await search(db, cfg, terms, { k, where: ctx.values.where, preset: ctx.values.preset, include: ctx.values.include, semantic: ctx.values.lexical ? false : undefined }), ctx.format));
};
export default searchCmd;
