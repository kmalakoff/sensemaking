import { renderMap } from '../output.ts';
import { vaultMap } from '../verbs.ts';
import type { Command } from './types.ts';
import { withVault } from './vault.ts';

const map: Command = (ctx) => {
  withVault(ctx, (db, cfg) => {
    const result = vaultMap(db, cfg);
    console.log(ctx.format === 'json' ? JSON.stringify(result, null, 2) : renderMap(result));
  });
};
export default map;
