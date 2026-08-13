import { renderMap } from '../output.ts';
import { mapTree } from '../verbs.ts';
import { withDb } from './shared.ts';
import type { Command } from './types.ts';

const map: Command = (ctx) => {
  withDb(ctx, (db, cfg) => {
    const result = mapTree(db, cfg);
    console.log(ctx.format === 'json' ? JSON.stringify(result, null, 2) : renderMap(result));
  });
};
export default map;
