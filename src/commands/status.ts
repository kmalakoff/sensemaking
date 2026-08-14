import { embedConfig, featureStates } from '../config.ts';
import { docCount, getMeta, open } from '../db.ts';
import { printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// Vectors are computed on the first semantic query, not at reconcile, so a tree can be
// embed-enabled with nothing embedded yet -- reported here because a fast `rebuild` on an
// embed tree otherwise reads as "the feature isn't on".
function vectorState(db: ReturnType<typeof open>['db']): { embedded: number; pending: number } | null {
  try {
    const row = db.prepare('SELECT COUNT(vector) AS embedded, COUNT(*) - COUNT(vector) AS pending FROM embeddings').get() as { embedded: number; pending: number };
    return row;
  } catch {
    return null;
  }
}

const status: Command = (ctx) => {
  const cfg = ctx.resolveConfig();
  const { db, dbPath, warnings } = open(cfg);
  printWarnings(warnings);

  const features = featureStates(cfg);
  const e = embedConfig(cfg);
  const vectors = e ? vectorState(db) : null;
  const heartbeat = getMeta(db, 'watch_heartbeat');
  const result = {
    db: dbPath,
    docs: docCount(db),
    features: features.on,
    featuresOff: features.off,
    embed: e ? { type: e.type, model: e.model, ...(vectors ?? {}) } : null,
    findDefaultWhere: cfg.defaults?.find?.where ?? null,
    watcherHeartbeatSecondsAgo: heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null,
  };

  if (ctx.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`db: ${result.db}`);
    console.log(`docs: ${result.docs}`);
    const off = features.off.length > 0 ? ` · off: ${features.off.map((name) => `${name} (features.${name})`).join(', ')}` : '';
    console.log(`features: ${features.on.join(', ')}${off}`);
    if (e) console.log(`embed: ${e.type} ${e.model}${vectors ? ` (vectors: ${vectors.embedded} embedded, ${vectors.pending} pending — embedded on first --semantic query)` : ''}`);
    if (result.findDefaultWhere) console.log(`find default scope: ${result.findDefaultWhere} (--where replaces it)`);
    console.log(result.watcherHeartbeatSecondsAgo === null ? 'watcher: no watcher' : `watcher: last heartbeat ${result.watcherHeartbeatSecondsAgo}s ago`);
  }
  db.close();
};
export default status;
