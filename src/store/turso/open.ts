import type { Database } from '@tursodatabase/database';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { featureSignature } from '../../config/index.ts';
import { STORE_DIMS } from '../../embed/types.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import type { OpenResult } from '../open.ts';
import { openWithDialect } from '../open.ts';
import { getMeta, setMeta } from '../shared.ts';
import type { Connection, OpenDialect } from '../types.ts';
import { createConnection } from './connection.ts';
import { TURSO_PACKAGE, tursoApi } from './native.ts';
import { CONTENT_FTS_DDL, tursoDialect } from './reconcile.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.turso.db';
// Independent of sqlite's and duckdb's SCHEMA_VERSION: each store's cache shape evolves
// separately. Covers the FTS indexes, the "_ngram" sidecar columns, and embeddings.vector's width.
export const SCHEMA_VERSION = '4';

export type { OpenResult };

// This store's Handle (types.ts's OpenDialect<Handle>) is the connected Database itself: no
// extra native state to thread, unlike duckdb's separate instance/connection pair.
async function ensureSchema(_handle: Database, conn: Connection, cfg: Config): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_ctime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT, title_ngram TEXT, summary_ngram TEXT, text_ngram TEXT)`);
  for (const ddl of CONTENT_FTS_DDL) await conn.exec(ddl);
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) {
    // Native F32_BLOB(STORE_DIMS) instead of the embed feature's engine-neutral BLOB DDL. `scale`
    // is kept unused, so the shared reconcile-time INSERT/DELETE names a column both stores have.
    if (feature.name === 'embed') {
      await conn.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector F32_BLOB(${STORE_DIMS}), PRIMARY KEY ("path", chunk))`);
      continue;
    }
    await feature.schema(conn);
  }
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
  if ((await getMeta(conn, 'features')) === null) await setMeta(conn, 'features', featureSignature(cfg, FEATURES));
}

async function close(handle: Database): Promise<void> {
  await handle.close();
}

async function setDerivedBusyTimeout(_handle: Database, conn: Connection, ms: number): Promise<void> {
  await conn.exec(`PRAGMA busy_timeout = ${ms}`);
}

async function connect(dbPath: string, _cfg: ResolvedConfig): Promise<{ handle: Database; conn: Connection }> {
  // Dynamic, not a top-level import: a sqlite or duckdb tree must never attempt to resolve this
  // optional dependency until a turso tree is actually opened. Installed on first use if missing.
  let turso: Awaited<ReturnType<typeof tursoApi>>;
  try {
    turso = await tursoApi();
  } catch (err) {
    if (err instanceof SenseError) throw err;
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "turso" needs the ${TURSO_PACKAGE} package (${(err as Error).message})`);
  }

  let db: Database;
  try {
    // Floored at the same 30s sqlite opens with. `timeout` is connect-time only in this client;
    // the derived value is set via runtime PRAGMA below. `index_method` is required for ensureSchema()'s FTS indexes (T1).
    db = await turso.connect(dbPath, { timeout: 30_000, experimental: ['index_method'] });
  } catch (err) {
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "turso" failed to open ${dbPath}: ${(err as Error).message}`);
  }
  return { handle: db, conn: createConnection(db) };
}

// This store's dialect (types.ts's OpenDialect) for the shared orchestration in store/open.ts.
export const tursoOpenDialect: OpenDialect<Database> = {
  filename: DB_FILENAME,
  schemaVersion: SCHEMA_VERSION,
  reconcileDialect: tursoDialect,
  connect,
  close,
  // "Locking error: Failed locking file ... File is locked by another process". Distinct from the
  // write-time "database is locked" its connect-time `timeout` covers; that one never reaches here.
  isLocked: (err) => /File is locked by another process/.test(err.message),
  ensureSchema,
  setDerivedBusyTimeout,
  createStore: (handle, conn) => createStore(handle, conn),
};

export async function openTurso(cfg: ResolvedConfig): Promise<OpenResult> {
  return openWithDialect(cfg, tursoOpenDialect);
}
