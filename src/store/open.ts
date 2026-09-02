import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import { featureSignature, STATE_DIR } from '../config/index.ts';
import { rekeyChunkText } from '../embed/handoff.ts';
import { SenseError } from '../errors.ts';
import { FEATURES } from '../features/index.ts';
import type { Builder } from './builder.ts';
import { createBuilder } from './builder.ts';
import { clearCache } from './cache.ts';
import { getMeta, setMeta } from './shared.ts';
import { changedSignatureKeys, embedIdentityAdopted, signatureDiff } from './signature.ts';
import type { Connection, OpenDialect, Store } from './types.ts';

// One open algorithm shared by every store, parameterised by a per-engine OpenDialect (types.ts).
// Ordering is universal, not a dialect concern: connect, meta table, schema-version and
// feature-signature comparison (rebuild, adopt, or partial rebuild), any extra rebuild trigger,
// ensureSchema, the derived busy_timeout PRAGMA, reconcile, then the store itself.

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

interface ConnectResult<Handle> {
  handle: Handle;
  conn: Connection;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
  // Closed already unless `keepBuilderOpen` was set: a one-shot open reconciles once and is done
  // with it, a watcher keeps calling build() on the same instance across its whole run.
  builder: Builder;
}

// duckdb and turso hold the cache file for their connection's whole life, not for a transaction,
// so a second command waits on the first command finishing. Bounded rather than open-ended: this
// clears a warm query's collision (~100ms) and still fails loudly behind a cold build instead of
// looking hung.
const LOCK_RETRY_MS = 5_000;
const LOCK_POLL_MS = 50;

async function connectUnlocked<Handle>(dbPath: string, cfg: ResolvedConfig, dialect: OpenDialect<Handle>): Promise<{ handle: Handle; conn: Connection }> {
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    try {
      return await dialect.connect(dbPath, cfg);
    } catch (err) {
      if (!dialect.isLocked?.(err as Error)) throw err;
      if (Date.now() >= deadline) {
        throw new SenseError('STORE_BUSY', `another sense process is using this tree's ${cfg.store} cache (${dbPath}) and did not release it within ${LOCK_RETRY_MS / 1000}s; wait for that command to finish, or set "store" to "sqlite" in sense.config.json, which serves concurrent commands`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function connectWithDialect<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>, keepBuilderOpen: boolean): Promise<ConnectResult<Handle>> {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, dialect.filename);

  const { handle, conn } = await connectUnlocked(dbPath, cfg, dialect);
  // A throw below must release this handle, or the leaked WAL makes the cache file undeletable on
  // Windows. `closed` keeps the catch from double-closing a handle a rebuild branch already closed.
  let closed = false;
  // Created here, not inside reconcile(): its pool must survive across every build() call this
  // connection sees (a watcher's repeated ticks), not just the one below.
  const builder = createBuilder(conn, cfg, cfg.baseDir, dialect.reconcileDialect);
  try {
    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    // Schema-version or feature-set mismatch: reconcile only reparses changed files, so an
    // old cache can't be patched incrementally -- rebuild instead (cheap: nothing expensive lives here).
    const version = await getMeta(conn, 'schema_version');
    const features = await getMeta(conn, 'features');
    const wantFeatures = featureSignature(cfg, FEATURES);
    let tokenizeOnlyRebuild = false;
    if ((version !== null && version !== dialect.schemaVersion) || (features !== null && features !== wantFeatures)) {
      // Indexing derives from presets, so a config edit rebuilding the cache must say so and
      // name what changed -- silent rebuilds make derived indexing look like a hang or a bug.
      if (version !== null && version !== dialect.schemaVersion) {
        console.error('sense: cache format changed (new sensemaking version); rebuilding the index');
        // Close before clearCache deletes the files out from under the still-open handle.
        closed = true;
        await dialect.close(handle);
        clearCache(cfg);
        return connectWithDialect(cfg, dialect, keepBuilderOpen);
      }
      const changedKeys = changedSignatureKeys(features ?? '', wantFeatures);
      // Only a dialect-owned carve-out (sqlite's tokenizer) skips the rebuild below with its own
      // partial DDL swap; every other single- or multi-segment change takes it.
      if (dialect.partialRebuild && (await dialect.partialRebuild(handle, conn, cfg, changedKeys))) {
        tokenizeOnlyRebuild = true;
      } else if (changedKeys.size === 1 && changedKeys.has('embed') && embedIdentityAdopted(features ?? '', wantFeatures)) {
        // First sight of a resolved weight identity: the model itself hasn't changed, so
        // adopt it into meta with no rebuild and no re-embed, mirroring the tokenize precedent.
        console.error("sense: recorded the embedding model's resolved identity; vectors are unaffected");
        await setMeta(conn, 'features', wantFeatures);
      } else {
        const changed = signatureDiff(features ?? '', wantFeatures);
        console.error(`sense: config change (${changed}) rebuilds the index`);
        closed = true;
        await dialect.close(handle);
        clearCache(cfg);
        return connectWithDialect(cfg, dialect, keepBuilderOpen);
      }
    }

    // A rebuild trigger independent of the signature comparison above (sqlite: the content
    // table's own DDL no longer matches the resolved tokenizer).
    const extraReason = dialect.extraRebuildReason ? dialect.extraRebuildReason(handle) : null;
    if (extraReason !== null) {
      console.error(`sense: ${extraReason}; rebuilding the index`);
      closed = true;
      await dialect.close(handle);
      clearCache(cfg);
      return connectWithDialect(cfg, dialect, keepBuilderOpen);
    }

    await dialect.ensureSchema(handle, conn, cfg);

    let rebuildWarnings: string[] = [];
    if (tokenizeOnlyRebuild && dialect.postSchemaRebuild) {
      rebuildWarnings = await dialect.postSchemaRebuild(handle, conn, cfg, cfg.baseDir, wantFeatures);
    }

    // 3x the largest reconcile this cache has recorded, floored at 30s and capped at 10min.
    // Installed before build() -- that call is the one that races a watcher's transaction.
    if (dialect.setDerivedBusyTimeout) {
      const recordedMaxMs = Number((await getMeta(conn, 'reconcile_max_ms')) ?? '0');
      await dialect.setDerivedBusyTimeout(handle, conn, Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000));
    }

    const { parsed, warnings } = await builder.build();
    // A one-shot open is done reconciling for good; a watcher keeps `builder` alive across its run.
    if (!keepBuilderOpen) await builder.close();

    return { handle, conn, cfg, dbPath, parsed, warnings: [...rebuildWarnings, ...warnings], builder };
  } catch (err) {
    await builder.close();
    if (!closed) await dialect.close(handle);
    throw err;
  }
}

// A store's open(): connects (see connectWithDialect above), then wraps the resulting connection
// in the Store interface. The builder's pool closes right after the initial build.
export async function openWithDialect<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>): Promise<OpenResult> {
  const { handle, conn, cfg: resolvedCfg, dbPath, parsed, warnings } = await connectWithDialect(cfg, dialect, false);
  const store = dialect.createStore(handle, conn, resolvedCfg);
  // reconcile ran before this object existed, so its chunk text is keyed by the connection.
  rekeyChunkText(conn, store);
  return { store, cfg: resolvedCfg, dbPath, parsed, warnings };
}

// Same connect+build as openWithDialect, but keeps the builder's pool alive and hands it back
// alongside the store, for a caller (a watcher) that reconciles repeatedly on this connection.
export async function openWithBuilder<Handle>(cfg: ResolvedConfig, dialect: OpenDialect<Handle>): Promise<OpenResult & { builder: Builder }> {
  const { handle, conn, cfg: resolvedCfg, dbPath, parsed, warnings, builder } = await connectWithDialect(cfg, dialect, true);
  const store = dialect.createStore(handle, conn, resolvedCfg);
  rekeyChunkText(conn, store);
  return { store, cfg: resolvedCfg, dbPath, parsed, warnings, builder };
}

export async function docCount(store: Store): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return ((await stmt.get()) as { n: number }).n;
}
