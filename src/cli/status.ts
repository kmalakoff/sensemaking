import { dirname, join } from 'node:path';
import { presetCoverage } from '../commands/status.ts';
import { embedConfig, featureStates, STATE_DIR, SUPPORTED_CONFIG_VERSION } from '../config/index.ts';
import { languageDistribution } from '../embed/distribution.ts';
import { probeReachable } from '../embed/http.ts';
import { isDownloadable, MODEL_FILENAMES, modelDir, modelPresent, readLanguages } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import { featuresLine, presetsLines, stringifyJson } from '../output/output.ts';
import type { OpenResult } from '../store/index.ts';
import { docCount, getMeta, lexicalReadiness, openStore, storeFilename } from '../store/index.ts';
import type { Store } from '../store/types.ts';
import { readWatchClaim } from '../watch-claim.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// status names what you cannot read off the config file: locations sense chose, values it derived, state it stored. Config content itself is not echoed, since duplicating its globs here would create two places that disagree after an edit.
// The exception is the embed block's url and key, whose effect is remote and otherwise invisible.

// A failed or interrupted vector preparation can leave core and lexical state usable. Status is
// observational, so it reports that pending capability instead of repairing it.
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
  const cfg = ctx.resolveConfig(values.config as string | undefined, { writeMigration: false });
  const lexical = await lexicalReadiness(cfg);
  let opened: OpenResult;
  try {
    opened = await openStore(cfg, { build: false });
  } catch (err) {
    if (!(err instanceof SenseError) || err.code !== 'INDEX_NOT_READY') throw err;
    const configDir = cfg.configDir ?? cfg.rootDir ?? cfg.baseDir;
    const dbPath = join(configDir, STATE_DIR, storeFilename(cfg));
    const watcher = readWatchClaim(configDir);
    const result = {
      config: cfg.configPath,
      configVersion: SUPPORTED_CONFIG_VERSION,
      migratedFrom: cfg.migratedFrom ?? null,
      unknownConfigKeys: cfg.unknownKeys ?? null,
      tree: cfg.rootDir ?? cfg.baseDir,
      treeRoot: cfg.rootDir ?? cfg.baseDir,
      configDir,
      cache: dirname(dbPath),
      db: dbPath,
      indexReady: false,
      indexError: err.message,
      lexicalReady: lexical.ready,
      lexicalError: lexical.error,
      watcherPid: watcher ? String(watcher.pid) : null,
      watcherHeartbeatSecondsAgo: watcher ? Math.round((Date.now() - watcher.heartbeatMs) / 1000) : null,
    };
    if (format === 'json') {
      console.log(stringifyJson(result, 2));
    } else {
      const migrated = cfg.migratedFrom !== undefined ? `, migration from v${cfg.migratedFrom} pending` : '';
      console.log(`config:   ${result.config} (v${SUPPORTED_CONFIG_VERSION}${migrated})`);
      console.log(`tree root: ${result.treeRoot}`);
      console.log(`configDir: ${result.configDir}`);
      console.log(`cache:    ${result.cache}`);
      console.log(`index:    not ready (${result.indexError})`);
      console.log(`lexical:  ${result.lexicalReady ? 'ready' : `not ready (${result.lexicalError})`}`);
      const pid = result.watcherPid ? `pid ${result.watcherPid}, ` : '';
      console.log(result.watcherHeartbeatSecondsAgo === null ? 'watcher:  none' : `watcher:  ${pid}last heartbeat ${result.watcherHeartbeatSecondsAgo}s ago`);
    }
    return;
  }
  const { store, dbPath, warnings } = opened;
  try {
    printWarnings(warnings);

    const features = featureStates(cfg);
    const e = embedConfig(cfg);
    const hasModel = e ? modelPresent(cfg) : false;
    const reachable = e ? await embedReachable(e) : null;
    const vectors = e ? await vectorState(store) : null;
    const presets = await presetCoverage(store, cfg);
    const { languages: declaredLanguages, state: languagesState, source: languagesSource } = e ? languagesInfo(e) : { languages: null, state: null, source: null };
    const detectedLanguages = (await languageDistribution(store)) ?? null;
    // This is the compatible cache's stored version. Observational open refuses a mismatch rather
    // than rebuilding it before this read.
    const cacheSchema = await getMeta(store, 'schema_version');
    // Each store owns what it reports and how it is worded (Store.engineStatus); this command
    // prints entries generically, without branching on any store's name.
    const engine = await store.engineStatus();
    const watcher = readWatchClaim(cfg.configDir ?? cfg.rootDir ?? cfg.baseDir);
    // The env var holds the token; only its name and whether it is set are ever reported.
    const keyEnv = e?.key ? { name: e.key, set: (process.env[e.key] ?? '') !== '' } : null;
    const result = {
      config: cfg.configPath,
      configVersion: SUPPORTED_CONFIG_VERSION,
      migratedFrom: cfg.migratedFrom ?? null,
      unknownConfigKeys: cfg.unknownKeys ?? null,
      tree: cfg.rootDir ?? cfg.baseDir,
      treeRoot: cfg.rootDir ?? cfg.baseDir,
      configDir: cfg.configDir ?? cfg.baseDir,
      cache: dirname(dbPath),
      db: dbPath,
      indexReady: true,
      indexError: null,
      lexicalReady: lexical.ready,
      lexicalError: lexical.error,
      cacheSchema,
      docs: await docCount(store),
      unparseableFrontmatter: await parseErrorCount(store),
      features: features.on,
      featuresOff: features.off,
      embed: e ? { provider: e.provider, model: e.model, dir: e.provider === 'static' ? modelDir(e.model) : null, url: e.url ? redactUrl(e.url) : null, reachable, keyEnv, downloaded: hasModel, languages: declaredLanguages, languagesState, detectedLanguages, ...(vectors ?? {}) } : null,
      presets,
      queries: Object.keys(cfg.queries ?? {}).length,
      watcherPid: watcher ? String(watcher.pid) : null,
      watcherHeartbeatSecondsAgo: watcher ? Math.round((Date.now() - watcher.heartbeatMs) / 1000) : null,
      engine,
    };

    if (format === 'json') {
      console.log(stringifyJson(result, 2));
    } else {
      const migrated = cfg.migratedFrom !== undefined ? `, migration from v${cfg.migratedFrom} applied in memory` : '';
      console.log(`config:   ${result.config} (v${SUPPORTED_CONFIG_VERSION}${migrated})`);
      // A load-time stderr warning has scrolled away by the time anyone looks here.
      if (cfg.unknownKeys) console.log(`          unknown keys, ignored: ${cfg.unknownKeys.join(', ')}`);
      console.log(`tree root: ${result.treeRoot}`);
      console.log(`configDir: ${result.configDir}`);
      console.log(`cache:    ${result.cache} (schema ${result.cacheSchema}; ${ctx.name} build --force to recreate)`);
      console.log(`lexical:  ${result.lexicalReady ? 'ready' : `not ready (${result.lexicalError})`}`);
      console.log(`docs:     ${result.docs}${result.unparseableFrontmatter > 0 ? `  (${result.unparseableFrontmatter} with unparseable frontmatter: WHERE _parse_error IS NOT NULL)` : ''}`);
      console.log('');
      console.log(featuresLine(features));
      // One authoritative block, off states included: an absent model reads as a degraded search,
      // not as an empty corpus.
      if (!e) console.log('embed:    off (no preset asks for vectors)');
      else {
        console.log(`embed:    ${e.provider} ${e.model}`);
        if (e.provider === 'static') console.log(`          model:   ${modelDir(e.model)} (${hasModel ? 'present' : `missing, ${isDownloadable(e.model) ? `fetches when build, watch, or a vector query needs it; run \`${ctx.name} download\` to prefetch` : `no ${MODEL_FILENAMES} in that directory`}`})`);
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
        if (!hasModel) console.log('          vectors: unavailable until the model is present; semantic queries fail, while lexical-only presets remain usable');
        else if (vectors) console.log(`          vectors: ${vectors.embedded} embedded, ${vectors.pending} pending${vectors.pending > 0 ? ` (run \`${ctx.name} build\` to prepare all configured vectors)` : ''}`);
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
  } finally {
    await store.close();
  }
};
export default status;
