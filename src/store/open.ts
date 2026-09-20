import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import { anyPresetEmbeds, featureSignature, STATE_DIR } from '../config/index.ts';
import { rekeyChunkText } from '../embed/handoff.ts';
import { embedPending } from '../embed/query.ts';
import { SenseError } from '../errors.ts';
import { FEATURES } from '../features/index.ts';
import { createBuilder } from './builder.ts';
import { clearCache } from './cache.ts';
import type { EmbedChangeKind } from './embed-scope.ts';
import { classifyEmbedChange } from './embed-scope.ts';
import type { FeatureToggle } from './feature-scope.ts';
import { classifyFeatureToggles, isFeatureOnlyChange } from './feature-scope.ts';
import { lockWaitBudgetMs } from './lock-wait.ts';
import { forcedPresetPaths, isPresetOnlyChange } from './preset-scope.ts';
import { getMeta, setMeta } from './shared.ts';
import { changedSignatureKeys, embedIdentityAdopted, signatureDiff } from './signature.ts';
import type { Stages } from './stages.ts';
import { stageRecorder } from './stages.ts';
import { withTransaction } from './transaction.ts';
import type { Connection, OpenDialect, Store } from './types.ts';

export type BuildRequirement = 'core' | 'lexical' | 'vectors';

export interface OpenOptions {
  build?: boolean;
}

export interface InternalOpenOptions extends OpenOptions {
  requirements?: ReadonlySet<BuildRequirement>;
}

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
  stages: Stages;
}

interface ConnectResult<Handle> {
  handle: Handle;
  conn: Connection;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
  stages: Stages;
  observational: boolean;
}

const CORE_READY_META_KEY = 'core_ready';
const LOCK_POLL_MS = 50;
const lockWait = channel('sensemaking.store.lock-wait');

function notReady(reason: string): SenseError {
  return new SenseError('INDEX_NOT_READY', `${reason}; run "sense build" or call build(config) before opening with { build: false }`);
}

function normaliseConfig(cfg: ResolvedConfig): ResolvedConfig {
  // `baseDir` was the original public open() input. Keep direct API callers working while
  // making the two ownership paths explicit for every internal operation.
  if (!cfg.rootDir) {
    if (!cfg.baseDir) throw new SenseError('CONFIG_INVALID', 'open requires rootDir (or legacy baseDir)');
    cfg.rootDir = cfg.baseDir;
  }
  if (!cfg.configDir) cfg.configDir = cfg.rootDir;
  return cfg;
}

function cachePath<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>): string {
  return join(cfg.configDir ?? cfg.baseDir, STATE_DIR, dialect.filename);
}

async function connectUnlocked<Handle>(dbPath: string, cfg: ResolvedConfig, configDir: string, dialect: OpenDialect<Handle>, options: { existingOnly: boolean; observational: boolean }): Promise<{ handle: Handle; conn: Connection }> {
  const budgetMs = lockWaitBudgetMs(configDir);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      return await dialect.connect(dbPath, cfg, options);
    } catch (err) {
      if (options.existingOnly && !existsSync(dbPath)) {
        throw notReady(`the derived index does not exist at ${dbPath}`);
      }
      if (!dialect.isLocked?.(err as Error)) throw err;
      if (lockWait.hasSubscribers) lockWait.publish({ store: cfg.store, dbPath });
      if (Date.now() >= deadline) {
        throw new SenseError('STORE_BUSY', `another sense process is using this tree's ${cfg.store} cache (${dbPath}) and did not release it within ${Math.round(budgetMs / 1000)}s; wait for that command to finish, or set "store" to "sqlite" in sense.config.json, which serves concurrent commands`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function assertCoreSchema(conn: Connection): Promise<void> {
  for (const table of ['frontmatter', 'content', 'preset_files', 'indexed_sources']) {
    await (await conn.prepare(`SELECT 1 FROM ${table} LIMIT 0`)).all();
  }
}

async function connectExisting<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>, requirements: ReadonlySet<BuildRequirement>): Promise<ConnectResult<Handle>> {
  const configDir = cfg.configDir ?? cfg.baseDir;
  const dbPath = cachePath(cfg, dialect);
  if (!existsSync(dbPath)) throw notReady(`the derived index does not exist at ${dbPath}`);

  const { handle, conn } = await connectUnlocked(dbPath, cfg, configDir, dialect, { existingOnly: true, observational: true });
  try {
    let version: string | null;
    let features: string | null;
    let ready: string | null;
    try {
      version = await getMeta(conn, 'schema_version');
      features = await getMeta(conn, 'features');
      ready = await getMeta(conn, CORE_READY_META_KEY);
      await assertCoreSchema(conn);
    } catch {
      if (!existsSync(dbPath)) throw notReady(`the derived index was deleted while opening ${dbPath}`);
      throw notReady(`the derived index at ${dbPath} has no compatible schema`);
    }

    if (version !== dialect.schemaVersion) {
      throw notReady(`the derived index at ${dbPath} uses schema ${version ?? 'unknown'}, but this sense version requires ${dialect.schemaVersion}`);
    }
    const wantFeatures = featureSignature(cfg, FEATURES);
    if (features !== wantFeatures) {
      throw notReady(`the derived index at ${dbPath} was built for different configuration features`);
    }
    if (ready !== '1') {
      throw notReady(`the derived index at ${dbPath} has an incomplete core build`);
    }
    if (requirements.has('lexical')) {
      await dialect.assertLexicalReady?.(conn);
    }
    if (!existsSync(dbPath)) throw notReady(`the derived index was deleted while opening ${dbPath}`);

    return {
      handle,
      conn,
      cfg,
      dbPath,
      parsed: 0,
      warnings: [],
      stages: stageRecorder().take(0, 0),
      observational: true,
    };
  } catch (err) {
    await dialect.close(handle, { observational: true });
    throw err;
  }
}

async function connectForBuild<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>, requirements: ReadonlySet<BuildRequirement>): Promise<ConnectResult<Handle>> {
  const configDir = cfg.configDir ?? cfg.baseDir;
  const stateDir = join(configDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, dialect.filename);

  const { handle, conn } = await connectUnlocked(dbPath, cfg, configDir, dialect, { existingOnly: false, observational: false });
  let closed = false;
  const builder = createBuilder(conn, cfg, { rootDir: cfg.rootDir ?? cfg.baseDir, configDir }, dialect.reconcileDialect);
  try {
    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    const version = await getMeta(conn, 'schema_version');
    const features = await getMeta(conn, 'features');
    const ready = await getMeta(conn, CORE_READY_META_KEY);
    const wantFeatures = featureSignature(cfg, FEATURES);
    // `ready=0` may belong to another SQLite builder, so recovery stays in place and lets the
    // engine serialize it. It never unlinks the cache.
    await setMeta(conn, CORE_READY_META_KEY, '0');
    const recoverIncomplete = ready === '0' && (version === null || version === dialect.schemaVersion);
    let forcedPaths: Set<string> | undefined;
    let embedInvalidate: EmbedChangeKind | undefined;
    let featureToggles: FeatureToggle[] | undefined;
    if (version !== null && version !== dialect.schemaVersion) {
      console.error('sense: cache format changed (new sensemaking version); rebuilding the index');
      closed = true;
      await dialect.close(handle);
      clearCache(cfg);
      return connectForBuild(cfg, dialect, requirements);
    }
    if (recoverIncomplete) {
      console.error('sense: recovering an incomplete index generation in place');
    } else if (features !== null && features !== wantFeatures) {
      const changedKeys = changedSignatureKeys(features ?? '', wantFeatures);
      const presetForced = isPresetOnlyChange(changedKeys) ? forcedPresetPaths(cfg, cfg.rootDir ?? cfg.baseDir, features ?? '', changedKeys) : null;
      const embedKind = changedKeys.size === 1 && changedKeys.has('embed') ? classifyEmbedChange(features ?? '', wantFeatures) : null;
      const toggles = isFeatureOnlyChange(changedKeys) ? classifyFeatureToggles(features ?? '', wantFeatures, changedKeys) : null;
      if (changedKeys.size === 1 && changedKeys.has('embed') && embedIdentityAdopted(features ?? '', wantFeatures)) {
        console.error("sense: recorded the embedding model's resolved identity; vectors are unaffected");
      } else if (embedKind !== null) {
        embedInvalidate = embedKind;
        console.error(embedKind === 'model' ? 'sense: config change (embed settings) invalidates only the stale vectors' : 'sense: config change (embed settings) rebuilds only the embeddings it affects');
      } else if (presetForced !== null) {
        forcedPaths = presetForced;
        const changed = signatureDiff(features ?? '', wantFeatures);
        console.error(`sense: config change (${changed}) reparses only the files it affects`);
      } else if (toggles !== null) {
        featureToggles = toggles;
        const changed = signatureDiff(features ?? '', wantFeatures);
        console.error(`sense: config change (${changed}) reparses only the feature it affects`);
      } else {
        const changed = signatureDiff(features ?? '', wantFeatures);
        console.error(`sense: config change (${changed}) rebuilds the index`);
        closed = true;
        await dialect.close(handle);
        clearCache(cfg);
        return connectForBuild(cfg, dialect, requirements);
      }
    }

    await dialect.ensureSchema(handle, conn, cfg);

    if (dialect.setDerivedBusyTimeout) {
      const recordedMaxMs = Number((await getMeta(conn, 'reconcile_max_ms')) ?? '0');
      await dialect.setDerivedBusyTimeout(handle, conn, Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000));
    }

    const embedParsed = embedInvalidate ? (await builder.invalidate(embedInvalidate)).parsed : 0;
    const featureParsed = featureToggles ? (await builder.invalidateFeatures(featureToggles)).parsed : 0;
    const { parsed, warnings, stages } = recoverIncomplete ? await builder.recover() : await builder.build(forcedPaths);
    await withTransaction(conn, async () => {
      await setMeta(conn, 'features', wantFeatures);
      await setMeta(conn, CORE_READY_META_KEY, '1');
    });

    // Lexical preparation is a separate capability stage. A failure leaves core usable and the
    // dialect's own lexical marker stale, so unrelated map/peek/path/sql commands stay available.
    if (requirements.has('lexical')) {
      await dialect.prepareLexical?.(conn);
    }

    await builder.close();
    return { handle, conn, cfg, dbPath, parsed: parsed + embedParsed + featureParsed, warnings, stages, observational: false };
  } catch (err) {
    await builder.close();
    if (!closed) await dialect.close(handle);
    throw err;
  }
}

// A static provider can resolve its identity while embedding. Publish it only after vectors
// succeed and only when the durable signature still matches the prepared generation.
export async function prepareDocumentEmbeddings(store: Store, cfg: ResolvedConfig, allowed?: ReadonlySet<string>): Promise<void> {
  const preparedSignature = await getMeta(store, 'features');
  await embedPending(store, cfg, allowed);
  const actualSignature = featureSignature(cfg, FEATURES);
  if (preparedSignature === actualSignature) return;

  const changedKeys = changedSignatureKeys(preparedSignature ?? '', actualSignature);
  if (preparedSignature === null || changedKeys.size !== 1 || !changedKeys.has('embed') || !embedIdentityAdopted(preparedSignature, actualSignature)) {
    throw notReady('the index configuration changed while vectors were being prepared');
  }

  const update = await store.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?');
  const result = await update.run(actualSignature, 'features', preparedSignature);
  if (Number(result.changes) !== 1) throw notReady('another build changed the index configuration while vectors were being prepared');
}

export async function openWithDialect<Handle>(input: ResolvedConfig, dialect: OpenDialect<Handle>, options: InternalOpenOptions = {}): Promise<OpenResult> {
  const cfg = normaliseConfig(input);
  const buildEnabled = options.build !== false;
  const defaultRequirements = new Set<BuildRequirement>(buildEnabled ? ['core', 'lexical'] : ['core']);
  if (buildEnabled && anyPresetEmbeds(cfg)) defaultRequirements.add('vectors');
  const requirements = options.requirements ?? defaultRequirements;
  const connected = buildEnabled ? await connectForBuild(cfg, dialect, requirements) : await connectExisting(cfg, dialect, requirements);
  let store: Store | undefined;
  try {
    store = dialect.createStore(connected.handle, connected.conn, connected.cfg, { observational: connected.observational });
    rekeyChunkText(connected.conn, store);
    if (requirements.has('vectors') && buildEnabled) await prepareDocumentEmbeddings(store, connected.cfg);
    return {
      store,
      cfg: connected.cfg,
      dbPath: connected.dbPath,
      parsed: connected.parsed,
      warnings: connected.warnings,
      stages: connected.stages,
    };
  } catch (err) {
    if (store) await store.close();
    else await dialect.close(connected.handle, { observational: connected.observational });
    throw err;
  }
}

export async function docCount(store: Store): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return ((await stmt.get()) as { n: number }).n;
}
