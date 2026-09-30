import { channel } from 'node:diagnostics_channel';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import { anyPresetEmbeds, featureSignature, STATE_DIR } from '../config/index.ts';
import { rekeyChunkText } from '../embed/handoff.ts';
import { embedPending } from '../embed/query.ts';
import type { EmbedCallOptions } from '../embed/types.ts';
import { SenseError } from '../errors.ts';
import { FEATURES } from '../features/index.ts';
import { createBuilder } from './builder.ts';
import { clearCache } from './cache.ts';
import { lockWaitBudgetMs } from './lock-wait.ts';
import { CORE_READY_META_KEY, FEATURE_SIGNATURE_META_KEY, isCoreReady, isPublishedFeatureSignature } from './readiness.ts';
import { getMeta } from './shared.ts';
import { changedSignatureKeys, embedIdentityAdopted } from './signature.ts';
import type { Stages } from './stages.ts';
import { stageRecorder } from './stages.ts';
import { withTransaction } from './transaction.ts';
import type { Connection, OpenDialect, Store } from './types.ts';

export type BuildRequirement = 'core' | 'lexical' | 'vectors';

/** Options for the root `open(config, options)` API. */
export interface OpenOptions {
  /** Prepares configured capabilities by default; `false` opens compatible published state without repair. */
  build?: boolean;
  /** Cancels supported provider I/O and stops between phases after active native work finishes. */
  signal?: AbortSignal;
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
    let state: { version: string | null; features: string | null; ready: string | null };
    try {
      state = await withTransaction(conn, async () => {
        const version = await getMeta(conn, 'schema_version');
        const features = await getMeta(conn, FEATURE_SIGNATURE_META_KEY);
        const ready = await getMeta(conn, CORE_READY_META_KEY);
        await assertCoreSchema(conn);
        return { version, features, ready };
      });
    } catch {
      if (!existsSync(dbPath)) throw notReady(`the derived index was deleted while opening ${dbPath}`);
      throw notReady(`the derived index at ${dbPath} has no compatible schema`);
    }

    if (state.version !== dialect.schemaVersion) {
      throw notReady(`the derived index at ${dbPath} uses schema ${state.version ?? 'unknown'}, but this sense version requires ${dialect.schemaVersion}`);
    }
    const wantFeatures = featureSignature(cfg, FEATURES);
    if (!isPublishedFeatureSignature(state.features, wantFeatures)) {
      throw notReady(`the derived index at ${dbPath} was built for different configuration features`);
    }
    if (!isCoreReady(state.ready)) {
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

async function connectForBuild<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>, requirements: ReadonlySet<BuildRequirement>, cacheReplaced = false): Promise<ConnectResult<Handle>> {
  const configDir = cfg.configDir ?? cfg.baseDir;
  const stateDir = join(configDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, dialect.filename);

  const { handle, conn } = await connectUnlocked(dbPath, cfg, configDir, dialect, { existingOnly: false, observational: false });
  let closed = false;
  let builder: ReturnType<typeof createBuilder> | undefined;
  try {
    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    const version = await getMeta(conn, 'schema_version');
    if (version !== null && version !== dialect.schemaVersion) {
      console.error('sense: cache format changed (new sensemaking version); rebuilding the index');
      await dialect.close(handle);
      closed = true;
      if (cacheReplaced) throw notReady(`the derived index at ${dbPath} still reports incompatible schema ${version} after cache replacement`);
      clearCache(cfg);
      return connectForBuild(cfg, dialect, requirements, true);
    }

    if (version === null) await dialect.ensureCoreSchema(handle, conn);
    await dialect.prepareConnection?.(handle, conn, cfg);

    if (dialect.setDerivedBusyTimeout) {
      const recordedMaxMs = Number((await getMeta(conn, 'reconcile_max_ms')) ?? '0');
      await dialect.setDerivedBusyTimeout(handle, conn, Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000));
    }

    builder = createBuilder(conn, cfg, dialect.reconcileDialect, (snapshotCfg) => dialect.ensureFeatureSchema(handle, conn, snapshotCfg));
    const { parsed, warnings, stages, messages } = await builder.build();
    for (const message of messages) console.error(message);

    // Lexical preparation is a separate capability stage. A failure leaves core usable and the
    // dialect's own lexical marker stale, so unrelated map/peek/path/sql commands stay available.
    if (requirements.has('lexical')) {
      await dialect.prepareLexical?.(conn);
    }

    await builder.close();
    return { handle, conn, cfg, dbPath, parsed, warnings, stages, observational: false };
  } catch (err) {
    const cleanupTasks: Array<Promise<void>> = [];
    if (builder) {
      const builderToClose = builder;
      cleanupTasks.push(Promise.resolve().then(() => builderToClose.close()));
    }
    if (!closed) cleanupTasks.push(Promise.resolve().then(() => dialect.close(handle)));
    const cleanup = await Promise.allSettled(cleanupTasks);
    const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (cleanupErrors.length > 0) throw new AggregateError([err, ...cleanupErrors], 'opening the derived index failed and cleanup also failed');
    throw err;
  }
}

// A static provider can resolve its identity while embedding. Publish it only after vectors
// succeed and only when the durable signature still matches the prepared generation.
export async function prepareDocumentEmbeddings(store: Store, cfg: ResolvedConfig, allowed?: ReadonlySet<string>, options: EmbedCallOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  const preparedSignature = await getMeta(store, FEATURE_SIGNATURE_META_KEY);
  options.signal?.throwIfAborted();
  await embedPending(store, cfg, allowed, preparedSignature, options);
  options.signal?.throwIfAborted();
  const actualSignature = featureSignature(cfg, FEATURES);
  if (preparedSignature === actualSignature) return;

  const changedKeys = changedSignatureKeys(preparedSignature ?? '', actualSignature);
  if (preparedSignature === null || changedKeys.size !== 1 || !changedKeys.has('embed') || !embedIdentityAdopted(preparedSignature, actualSignature)) {
    throw notReady('the index configuration changed while vectors were being prepared');
  }

  await store.transaction(async () => {
    options.signal?.throwIfAborted();
    const update = await store.prepare('UPDATE meta SET value = ? WHERE key = ? AND value = ?');
    options.signal?.throwIfAborted();
    const result = await update.run(actualSignature, FEATURE_SIGNATURE_META_KEY, preparedSignature);
    options.signal?.throwIfAborted();
    if (Number(result.changes) !== 1) throw notReady('another build changed the index configuration while vectors were being prepared');
  });
}

export async function openWithDialect<Handle>(input: ResolvedConfig, dialect: OpenDialect<Handle>, options: InternalOpenOptions = {}): Promise<OpenResult> {
  options.signal?.throwIfAborted();
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
    if (requirements.has('vectors') && buildEnabled) await prepareDocumentEmbeddings(store, connected.cfg, undefined, { signal: options.signal });
    options.signal?.throwIfAborted();
    return {
      store,
      cfg: connected.cfg,
      dbPath: connected.dbPath,
      parsed: connected.parsed,
      warnings: connected.warnings,
      stages: connected.stages,
    };
  } catch (err) {
    const cleanup = await Promise.allSettled([Promise.resolve().then(() => (store ? store.close() : dialect.close(connected.handle, { observational: connected.observational })))]);
    if (cleanup[0].status === 'rejected') throw new AggregateError([err, cleanup[0].reason], 'opening the derived index failed and cleanup also failed');
    throw err;
  }
}

export async function docCount(store: Store): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return ((await stmt.get()) as { n: number }).n;
}
