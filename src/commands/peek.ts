import { renderPeek } from '../output.ts';
import { peek } from '../verbs.ts';
import { withDb } from './shared.ts';
import type { Command } from './types.ts';

const peekCmd: Command = (ctx) => {
  const [pathArg] = ctx.rest;
  if (!pathArg) ctx.usageError(`usage: ${ctx.name} peek <path>`);
  withDb(ctx, (db, cfg) => {
    const result = peek(db, cfg, pathArg);
    console.log(ctx.format === 'json' ? JSON.stringify(result, null, 2) : renderPeek(result));
  });
};
export default peekCmd;
