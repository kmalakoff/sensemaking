import { docCount, getMeta, open } from '../db.ts';
import type { Command } from './types.ts';
import { printWarnings } from './vault.ts';

const status: Command = (ctx) => {
  const { db, dbPath, warnings } = open(ctx.resolveConfig());
  printWarnings(warnings);
  console.log(`db: ${dbPath}`);
  console.log(`docs: ${docCount(db)}`);
  const heartbeat = getMeta(db, 'watch_heartbeat');
  if (heartbeat) console.log(`watcher: last heartbeat ${Math.round((Date.now() - Date.parse(heartbeat)) / 1000)}s ago`);
  else console.log('watcher: no watcher');
  db.close();
};
export default status;
