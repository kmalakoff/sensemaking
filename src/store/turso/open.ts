import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@tursodatabase/database';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { featureSignature, STATE_DIR } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { getMeta, setMeta } from '../shared.ts';
import { clearCache } from '../sqlite/open.ts';
import type { Connection, Store } from '../types.ts';
import { createConnection } from './connection.ts';
import { TURSO_PACKAGE, tursoApi } from './native.ts';
import { reconcile } from './reconcile.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.turso.db';
// Independent of sqlite's SCHEMA_VERSION and duckdb's -- each store's cache shape evolves
// separately, and the store name already joins the feature signature (see featureSignature), so
// a config's `store` key switching cleanly rebuilds rather than reusing another engine's cache.
export const SCHEMA_VERSION = '1';

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

// content is a plain table (not FTS-virtual): phase 1 creates no FTS index at all -- that is
// phase 2's job (see the plan). Untyped ALTER TABLE ADD COLUMN, like sqlite -- turso's dialect
// accepts it with no declared type (spike-confirmed), unlike duckdb which requires VARIANT.
async function ensureSchema(conn: Connection, cfg: Config): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_ctime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) await feature.schema(conn);
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
  if ((await getMeta(conn, 'features')) === null) await setMeta(conn, 'features', featureSignature(cfg, FEATURES));
}

interface ConnectResult {
  db: Database;
  conn: Connection;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

async function connect(cfg: ResolvedConfig): Promise<ConnectResult> {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  // Dynamic, not a top-level import: a sqlite or duckdb tree must never even attempt to resolve
  // this optional dependency, so nothing in this store's module graph imports it as a value until
  // a turso tree is actually opened (type-only imports elsewhere are erased and cost nothing
  // either way). Installed on first use if missing (see native.ts's tursoApi).
  let turso: Awaited<ReturnType<typeof tursoApi>>;
  try {
    turso = await tursoApi();
  } catch (err) {
    if (err instanceof SenseError) throw err;
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "turso" needs the ${TURSO_PACKAGE} package (${(err as Error).message})`);
  }

  let db: Database;
  try {
    // Floored at the same 30s sqlite opens with. `timeout` is a connect-time option in this
    // client (no synchronous PRAGMA-at-open-time escape hatch), so the real derived value --
    // which depends on this cache's own recorded reconcile_max_ms, readable only once connected
    // -- is installed via a runtime PRAGMA below, right before the open-time reconcile, the same
    // lever sqlite's open() uses (spike-confirmed: raw PRAGMA busy_timeout works as a setter too).
    db = await turso.connect(dbPath, { timeout: 30_000 });
  } catch (err) {
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "turso" failed to open ${dbPath}: ${(err as Error).message}`);
  }
  // A throw below (schema, reconcile's COLUMN_LIMIT) must release this handle, or the leaked WAL
  // makes the db file undeletable on Windows. closed marks the rebuild branch that closes and
  // recurses, so the catch never double-closes.
  let closed = false;
  try {
    const conn = createConnection(db);

    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    const version = await getMeta(conn, 'schema_version');
    const features = await getMeta(conn, 'features');
    const wantFeatures = featureSignature(cfg, FEATURES);
    if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
      // Reconcile only reparses changed files, so a stale cache can't be patched incrementally --
      // rebuild instead, same as sqlite's and duckdb's open() (see their comments for why this is
      // announced). No tokenize-only or embed-identity-adopted partial path (sqlite's grace for
      // those): turso has no content.tokenize knob to special-case, and the grace is an
      // optimization, not a correctness requirement -- any mismatch rebuilds, duckdb's shape.
      const reason = version !== null && version !== SCHEMA_VERSION ? 'cache format changed (new sensemaking version)' : 'config change (features, tokenizer, or presets)';
      console.error(`sense: ${reason}; rebuilding the index`);
      closed = true;
      await db.close();
      clearCache(cfg);
      return connect(cfg);
    }

    await ensureSchema(conn, cfg);

    // 3x the largest reconcile this cache has recorded, floored at 30s and capped at 10min.
    // Installed before reconcile() -- that call is the one that races a watcher's transaction.
    const recordedMaxMs = Number((await getMeta(conn, 'reconcile_max_ms')) ?? '0');
    await conn.exec(`PRAGMA busy_timeout = ${Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000)}`);

    const { parsed, warnings } = await reconcile(conn, cfg, cfg.baseDir);

    return { db, conn, cfg, dbPath, parsed, warnings };
  } catch (err) {
    if (!closed) await db.close();
    throw err;
  }
}

// The turso store's open: connects (fully async, see connect() above), then wraps the resulting
// connection in the Store interface.
export async function openTurso(cfg: ResolvedConfig): Promise<OpenResult> {
  const { db, conn, cfg: resolvedCfg, dbPath, parsed, warnings } = await connect(cfg);
  return { store: createStore(db, conn, resolvedCfg, resolvedCfg.baseDir), cfg: resolvedCfg, dbPath, parsed, warnings };
}
