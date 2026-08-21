import { presetCoverage } from '../commands.ts';
import { embedConfig, featureStates } from '../config.ts';
import { docCount, getMeta, open } from '../db.ts';
import { isDownloadable, MODEL_FILENAMES, modelPresent } from '../features/embed.ts';
import { featuresLine, presetsLines } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// Vectors are computed on the first semantic query, not at reconcile, so a tree can have a
// semantic-on preset with nothing embedded yet -- reported here because a fast `rebuild` on
// such a tree otherwise reads as "the feature isn't on".
function vectorState(db: ReturnType<typeof open>['db']): { embedded: number; pending: number } | null {
  try {
    const row = db.prepare('SELECT COUNT(vector) AS embedded, COUNT(*) - COUNT(vector) AS pending FROM embeddings').get() as { embedded: number; pending: number };
    return row;
  } catch {
    return null;
  }
}

const status: Command = (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.status}`, { ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  const cfg = ctx.resolveConfig(values.config as string | undefined);
  const { db, dbPath, warnings } = open(cfg);
  printWarnings(warnings);

  const features = featureStates(cfg);
  const e = embedConfig(cfg);
  const hasModel = e ? modelPresent(cfg) : false;
  const vectors = e ? vectorState(db) : null;
  const presets = presetCoverage(db, cfg);
  const heartbeat = getMeta(db, 'watch_heartbeat');
  // Derived at open() (F): 3x the largest reconcile this cache has ever held its write
  // transaction for, floored at 30s -- read back from the connection rather than
  // recomputed here, so this always reports what open() actually set.
  const busyTimeoutMs = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
  const result = {
    db: dbPath,
    docs: docCount(db),
    features: features.on,
    featuresOff: features.off,
    embed: e ? { type: e.type, model: e.model, downloaded: hasModel, ...(vectors ?? {}) } : null,
    presets,
    watcherHeartbeatSecondsAgo: heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null,
    busyTimeoutMs,
  };

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`db: ${result.db}`);
    console.log(`docs: ${result.docs}`);
    console.log(featuresLine(features));
    // One authoritative line, off states included: an absent model reads as a degraded
    // search, not as an empty corpus.
    if (!e) console.log('embed: off (no preset asks for vectors)');
    else if (!hasModel) console.log(`embed: ${e.type} ${e.model} — unavailable, so search runs on words and links only (${isDownloadable(e.model) ? `run \`${ctx.name} download\`` : `no ${MODEL_FILENAMES} in that directory`})`);
    else console.log(`embed: ${e.type} ${e.model}${vectors ? ` (vectors: ${vectors.embedded} embedded, ${vectors.pending} pending — embedded on the first semantic search)` : ''}`);
    for (const line of presetsLines(presets)) console.log(line);
    console.log(result.watcherHeartbeatSecondsAgo === null ? 'watcher: no watcher' : `watcher: last heartbeat ${result.watcherHeartbeatSecondsAgo}s ago`);
    console.log(`busy_timeout: ${result.busyTimeoutMs}ms (derived: 3x the largest reconcile this cache has recorded, floored at 30000ms)`);
  }
  db.close();
};
export default status;
