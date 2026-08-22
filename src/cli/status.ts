import { dirname } from 'node:path';
import { presetCoverage } from '../commands.ts';
import { embedConfig, featureStates, SUPPORTED_CONFIG_VERSION } from '../config.ts';
import { docCount, getMeta, open, SCHEMA_VERSION } from '../db.ts';
import { isDownloadable, MODEL_FILENAMES, modelDir, modelPresent } from '../features/embed.ts';
import { featuresLine, presetsLines } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// status names what you cannot read off the config file: locations sense chose, values it
// derived, state it stored. Config content is not echoed -- the config line says which file to
// read, and duplicating its globs here would create two places that disagree after an edit.
// The exception is the embed block's url and key, whose effect is remote and otherwise invisible.

// Vectors are computed on the first semantic query, not at reconcile, so a tree can have a
// semantic-on preset with nothing embedded yet -- reported here because a fast reconcile on
// such a tree otherwise reads as "the feature isn't on".
function vectorState(db: ReturnType<typeof open>['db']): { embedded: number; pending: number } | null {
  try {
    const row = db.prepare('SELECT COUNT(vector) AS embedded, COUNT(*) - COUNT(vector) AS pending FROM embeddings').get() as { embedded: number; pending: number };
    return row;
  } catch {
    return null;
  }
}

function parseErrorCount(db: ReturnType<typeof open>['db']): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM frontmatter WHERE "_parse_error" IS NOT NULL`).get() as { n: number };
  return row.n;
}

// A URL can carry credentials in its userinfo (https://user:pass@host/v1). status output gets
// pasted into issues and transcripts, so it is always safe to paste.
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return `${parsed.toString().replace(/\/$/, '')} (credentials redacted)`;
  } catch {
    return url;
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
  // The env var holds the token; only its name and whether it is set are ever reported.
  const keyEnv = e?.key ? { name: e.key, set: (process.env[e.key] ?? '') !== '' } : null;
  const result = {
    config: cfg.configPath,
    configVersion: SUPPORTED_CONFIG_VERSION,
    migratedFrom: cfg.migratedFrom ?? null,
    unknownConfigKeys: cfg.unknownKeys ?? null,
    tree: cfg.baseDir,
    cache: dirname(dbPath),
    db: dbPath,
    cacheSchema: SCHEMA_VERSION,
    docs: docCount(db),
    unparseableFrontmatter: parseErrorCount(db),
    features: features.on,
    featuresOff: features.off,
    embed: e ? { type: e.type, model: e.model, dir: e.type === 'static' ? modelDir(e.model) : null, url: e.url ? redactUrl(e.url) : null, keyEnv, downloaded: hasModel, ...(vectors ?? {}) } : null,
    presets,
    queries: Object.keys(cfg.queries ?? {}).length,
    watcherPid: getMeta(db, 'watch_pid'),
    watcherHeartbeatSecondsAgo: heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null,
    busyTimeoutMs,
  };

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const migrated = cfg.migratedFrom !== undefined ? `, migrated from v${cfg.migratedFrom} on this run` : '';
    console.log(`config:   ${result.config} (v${SUPPORTED_CONFIG_VERSION}${migrated})`);
    // A load-time stderr warning has scrolled away by the time anyone looks here.
    if (cfg.unknownKeys) console.log(`          unknown keys, ignored: ${cfg.unknownKeys.join(', ')}`);
    console.log(`tree:     ${result.tree}`);
    console.log(`cache:    ${result.cache} (schema ${SCHEMA_VERSION}; delete this directory to reset)`);
    console.log(`docs:     ${result.docs}${result.unparseableFrontmatter > 0 ? `  (${result.unparseableFrontmatter} with unparseable frontmatter: WHERE _parse_error IS NOT NULL)` : ''}`);
    console.log('');
    console.log(featuresLine(features));
    // One authoritative block, off states included: an absent model reads as a degraded search,
    // not as an empty corpus.
    if (!e) console.log('embed:    off (no preset asks for vectors)');
    else {
      console.log(`embed:    ${e.type} ${e.model}`);
      if (e.type === 'static') console.log(`          model:   ${modelDir(e.model)} (${hasModel ? 'present' : `missing, ${isDownloadable(e.model) ? `run \`${ctx.name} download\`` : `no ${MODEL_FILENAMES} in that directory`}`})`);
      if (e.url) console.log(`          url:     ${redactUrl(e.url)}`);
      if (keyEnv) console.log(`          key:     env ${keyEnv.name} (${keyEnv.set ? 'set' : 'NOT SET'})`);
      if (!hasModel) console.log('          vectors: off until the model is present; search runs on words and links');
      else if (vectors) console.log(`          vectors: ${vectors.embedded} embedded, ${vectors.pending} pending (embedded on the first semantic search)`);
    }
    console.log('');
    for (const line of presetsLines(presets)) console.log(line);
    console.log('');
    console.log(`queries:  ${result.queries} saved (${ctx.name} --list)`);
    const pid = result.watcherPid ? `pid ${result.watcherPid}, ` : '';
    console.log(result.watcherHeartbeatSecondsAgo === null ? 'watcher:  none' : `watcher:  ${pid}last heartbeat ${result.watcherHeartbeatSecondsAgo}s ago`);
    console.log(`sqlite:   busy_timeout ${result.busyTimeoutMs}ms (derived: 3x the largest reconcile this cache has recorded, floored at 30000ms)`);
  }
  db.close();
};
export default status;
