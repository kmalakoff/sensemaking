import { embedConfig, featureStates } from '../config.ts';
import { docCount, getMeta, open } from '../db.ts';
import { printWarnings } from './shared.ts';
import type { Command } from './types.ts';

const status: Command = (ctx) => {
  const cfg = ctx.resolveConfig();
  const { db, dbPath, warnings } = open(cfg);
  printWarnings(warnings);
  console.log(`db: ${dbPath}`);
  console.log(`docs: ${docCount(db)}`);
  const features = featureStates(cfg);
  const off = features.off.length > 0 ? ` · off: ${features.off.map((name) => `${name} (features.${name})`).join(', ')}` : '';
  console.log(`features: ${features.on.join(', ')}${off}`);
  const e = embedConfig(cfg);
  if (e) console.log(`embed: ${e.type} ${e.model}`);
  const heartbeat = getMeta(db, 'watch_heartbeat');
  if (heartbeat) console.log(`watcher: last heartbeat ${Math.round((Date.now() - Date.parse(heartbeat)) / 1000)}s ago`);
  else console.log('watcher: no watcher');
  db.close();
};
export default status;
