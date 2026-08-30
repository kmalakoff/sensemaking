import { dirname } from 'node:path';
import { presetCoverage } from '../commands/status.ts';
import { embedConfig, featureStates, SUPPORTED_CONFIG_VERSION } from '../config/index.ts';
import { languageDistribution } from '../embed/distribution.ts';
import { probeReachable } from '../embed/http.ts';
import { isDownloadable, MODEL_FILENAMES, modelDir, modelPresent, readLanguages } from '../embed/store.ts';
import { featuresLine, presetsLines, stringifyJson } from '../output/output.ts';
import { docCount, getMeta, openStore } from '../store/index.ts';
import type { Store } from '../store/types.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// status names what you cannot read off the config file: locations sense chose, values it derived, state it stored. Config content itself is not echoed, since duplicating its globs here would create two places that disagree after an edit.
// The exception is the embed block's url and key, whose effect is remote and otherwise invisible.

// Vectors are computed on the first semantic query, not at reconcile, so a tree can have a semantic-on preset with nothing embedded yet.
// Reported here because a fast reconcile on such a tree otherwise reads as "the feature isn't on".
async function vectorState(store: Store): Promise<{ embedded: number; pending: number } | null> {
  try {
    const stmt = await store.prepare('SELECT COUNT(vector) AS embedded, COUNT(*) - COUNT(vector) AS pending FROM embeddings');
    return (await stmt.get()) as { embedded: number; pending: number };
  } catch {
    return null;
  }
}

async function parseErrorCount(store: Store): Promise<number> {
  const stmt = await store.prepare(`SELECT COUNT(*) AS n FROM frontmatter WHERE "_parse_error" IS NOT NULL`);
  return ((await stmt.get()) as { n: number }).n;
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

// A stopped Ollama/LM Studio/Cohere endpoint prints identically to a running one otherwise; any
// HTTP response counts as reachable (probeReachable), so this only distinguishes up from down.
async function embedReachable(e: { provider: string; url?: string }): Promise<boolean | null> {
  if (e.provider === 'static' || (e.provider === 'openai' && !e.url)) return null;
  const base = (e.url ?? 'https://api.cohere.com').replace(/\/+$/, '');
  return probeReachable(e.provider === 'openai' ? `${base}/models` : base);
}

type LanguagesState = 'declared' | 'none' | 'unresolved' | null;

// Config-declared languages win over the model card, for every provider, as registry.ts does.
// A local-path model has no card by design, so it is never "unresolved": that means an HF id.
function languagesInfo(e: NonNullable<ReturnType<typeof embedConfig>>): { languages: string[] | null; state: LanguagesState; source: 'config' | 'card' | null } {
  if (e.languages) return { languages: e.languages, state: 'declared', source: 'config' };
  if (e.provider !== 'static' || !isDownloadable(e.model)) return { languages: null, state: null, source: null };
  const cardLanguages = readLanguages(e.model);
  if (cardLanguages === undefined) return { languages: null, state: 'unresolved', source: null };
  if (cardLanguages.length === 0) return { languages: null, state: 'none', source: null };
  return { languages: cardLanguages, state: 'declared', source: 'card' };
}

const status: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.status}`, { ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  const cfg = ctx.resolveConfig(values.config as string | undefined);
  const { store, dbPath, warnings } = await openStore(cfg);
  printWarnings(warnings);

  const features = featureStates(cfg);
  const e = embedConfig(cfg);
  const hasModel = e ? modelPresent(cfg) : false;
  const reachable = e ? await embedReachable(e) : null;
  const vectors = e ? await vectorState(store) : null;
  const presets = await presetCoverage(store, cfg);
  const { languages: declaredLanguages, state: languagesState, source: languagesSource } = e ? languagesInfo(e) : { languages: null, state: null, source: null };
  const detectedLanguages = (await languageDistribution(store)) ?? null;
  const heartbeat = await getMeta(store, 'watch_heartbeat');
  // Written by the store's open() on every open, so it is this cache's true version on either
  // store (sqlite 18, duckdb 2); a version mismatch already triggered a rebuild before this read.
  const cacheSchema = await getMeta(store, 'schema_version');
  // Each store owns what it reports and how it is worded (Store.engineStatus); this command
  // prints entries generically, without branching on any store's name.
  const engine = await store.engineStatus();
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
    cacheSchema,
    docs: await docCount(store),
    unparseableFrontmatter: await parseErrorCount(store),
    features: features.on,
    featuresOff: features.off,
    embed: e ? { provider: e.provider, model: e.model, dir: e.provider === 'static' ? modelDir(e.model) : null, url: e.url ? redactUrl(e.url) : null, reachable, keyEnv, downloaded: hasModel, languages: declaredLanguages, languagesState, detectedLanguages, ...(vectors ?? {}) } : null,
    presets,
    queries: Object.keys(cfg.queries ?? {}).length,
    watcherPid: await getMeta(store, 'watch_pid'),
    watcherHeartbeatSecondsAgo: heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null,
    engine,
  };

  if (format === 'json') {
    console.log(stringifyJson(result, 2));
  } else {
    const migrated = cfg.migratedFrom !== undefined ? `, migrated from v${cfg.migratedFrom} on this run` : '';
    console.log(`config:   ${result.config} (v${SUPPORTED_CONFIG_VERSION}${migrated})`);
    // A load-time stderr warning has scrolled away by the time anyone looks here.
    if (cfg.unknownKeys) console.log(`          unknown keys, ignored: ${cfg.unknownKeys.join(', ')}`);
    console.log(`tree:     ${result.tree}`);
    console.log(`cache:    ${result.cache} (schema ${result.cacheSchema}; delete this directory to reset)`);
    console.log(`docs:     ${result.docs}${result.unparseableFrontmatter > 0 ? `  (${result.unparseableFrontmatter} with unparseable frontmatter: WHERE _parse_error IS NOT NULL)` : ''}`);
    console.log('');
    console.log(featuresLine(features));
    // One authoritative block, off states included: an absent model reads as a degraded search,
    // not as an empty corpus.
    if (!e) console.log('embed:    off (no preset asks for vectors)');
    else {
      console.log(`embed:    ${e.provider} ${e.model}`);
      if (e.provider === 'static') console.log(`          model:   ${modelDir(e.model)} (${hasModel ? 'present' : `missing, ${isDownloadable(e.model) ? `fetches automatically at first search, or run \`${ctx.name} download\` to prefetch` : `no ${MODEL_FILENAMES} in that directory`}`})`);
      if (declaredLanguages && languagesSource === 'config') console.log(`          languages: ${declaredLanguages.join(', ')} (declared in embed.languages)`);
      else if (declaredLanguages && languagesSource === 'card') console.log(`          languages: ${declaredLanguages.join(', ')} (declared by the model card)`);
      else if (languagesState === 'none') console.log('          languages: none declared by the model card');
      else if (languagesState === 'unresolved') console.log(`          languages: unresolved (model card unreachable; run \`${ctx.name} download\`)`);
      // Cohere defaults to api.cohere.com with no url in the config; show it anyway so the
      // reachability probe below has something to name.
      if (e.url || reachable !== null) {
        const shown = e.url ? redactUrl(e.url) : 'https://api.cohere.com (default)';
        console.log(`          url:     ${shown}${reachable === null ? '' : reachable ? ' (reachable)' : ' (unreachable)'}`);
      }
      if (keyEnv) console.log(`          key:     env ${keyEnv.name} (${keyEnv.set ? 'set' : 'NOT SET'})`);
      if (!hasModel) console.log('          vectors: off until the model is present; search runs on words and links');
      else if (vectors) console.log(`          vectors: ${vectors.embedded} embedded, ${vectors.pending} pending (embedded on the first semantic search)`);
      if (detectedLanguages) {
        const total = Object.values(detectedLanguages).reduce((a, b) => a + b, 0);
        const breakdown = Object.entries(detectedLanguages)
          .sort((a, b) => b[1] - a[1])
          .map(([code, n]) => `${code} ${Math.round((n / total) * 100)}%`)
          .join(', ');
        console.log(`          detected: ${breakdown} (${total} chunks classified)`);
      }
    }
    console.log('');
    for (const line of presetsLines(presets)) console.log(line);
    console.log('');
    console.log(`queries:  ${result.queries} saved (${ctx.name} --list)`);
    const pid = result.watcherPid ? `pid ${result.watcherPid}, ` : '';
    console.log(result.watcherHeartbeatSecondsAgo === null ? 'watcher:  none' : `watcher:  ${pid}last heartbeat ${result.watcherHeartbeatSecondsAgo}s ago`);
    for (const [key, value] of Object.entries(result.engine)) console.log(`${`${store.name}:`.padEnd(10)}${key} ${value}`);
  }
  await store.close();
};
export default status;
