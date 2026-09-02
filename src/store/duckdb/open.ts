import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
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
import { DUCKDB_PACKAGE, duckdbApi } from './native.ts';
import { duckdbDialect } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.duckdb';
// Independent of sqlite's SCHEMA_VERSION -- the two stores' cache shapes evolve separately (VARIANT frontmatter columns vs untyped).
// The store name already joins the feature signature, so switching a config's `store` key rebuilds rather than reusing the other engine's cache.
export const SCHEMA_VERSION = '3';

export type { OpenResult };

// The connection plus this store's own native handles (types.ts's OpenDialect<Handle>): the
// instance owns the WAL and must outlive the connection borrowed from it.
interface DuckdbHandle {
  instance: DuckDBInstance;
  duckdb: DuckDBConnection;
}

// `content` is a plain table (not FTS-virtual): the fts index is built over it lazily, only when a lexical query runs (lexical.ts), and read directly for contains() verification either way.
// No tokenizer resolution: this store always uses the fts extension's default (porter) stemmer.
async function ensureSchema(_handle: DuckdbHandle, conn: Connection, cfg: Config): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" DOUBLE, "_ctime" DOUBLE, "_size" INTEGER, "_parse_error" TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) {
    // Native FLOAT[STORE_DIMS] instead of the embed feature's engine-neutral BLOB+scale DDL (vectors.ts). `scale` is kept, unused,
    // so the feature's shared reconcile-time INSERT/DELETE (features/embed.ts) names a column that exists on both stores.
    if (feature.name === 'embed') {
      await conn.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector FLOAT[${STORE_DIMS}], PRIMARY KEY ("path", chunk))`);
      continue;
    }
    await feature.schema(conn);
  }
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
  if ((await getMeta(conn, 'features')) === null) await setMeta(conn, 'features', featureSignature(cfg, FEATURES));
}

// Order matters: the connection must be gone before the instance closes the WAL.
async function close(handle: DuckdbHandle): Promise<void> {
  handle.duckdb.disconnectSync();
  handle.instance.closeSync();
}

async function connect(dbPath: string, _cfg: ResolvedConfig): Promise<{ handle: DuckdbHandle; conn: Connection }> {
  // Dynamic, not a top-level import: sqlite trees must never attempt to resolve this optional peer dependency, so nothing imports
  // it as a value until a duckdb tree opens (types-only imports are erased). Installed on first use if missing, shared with sql-functions.ts and vectors.ts via native.ts's duckdbApi.
  let DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance;
  try {
    ({ DuckDBInstance } = await duckdbApi());
  } catch (err) {
    if (err instanceof SenseError) throw err;
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" needs the ${DUCKDB_PACKAGE} package (${(err as Error).message})`);
  }

  let duckdb: DuckDBConnection;
  let instance: DuckDBInstance | undefined;
  try {
    // On-disk files default to an older storage format for cross-version compatibility, which rejects VARIANT columns ("VARIANT
    // columns are not supported in storage versions prior to v1.5.0"); this store's dynamic frontmatter columns need VARIANT (reconcile.ts), so the floor is pinned explicitly.
    instance = await DuckDBInstance.create(dbPath, { storage_compatibility_version: 'v1.5.0' });
    duckdb = await instance.connect();
  } catch (err) {
    // create() may have succeeded before connect() failed: close it, or its WAL stays open.
    instance?.closeSync();
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" failed to open ${dbPath}: ${(err as Error).message}`);
  }
  // A throw below would leak the open instance, whose WAL then locks the .duckdb file undeletable on Windows.
  try {
    await registerFunctions(duckdb);
    const conn = createConnection(duckdb);
    return { handle: { instance, duckdb }, conn };
  } catch (err) {
    await close({ instance, duckdb });
    throw err;
  }
}

// This store's dialect (types.ts's OpenDialect) for the shared orchestration in store/open.ts.
export const duckdbOpenDialect: OpenDialect<DuckdbHandle> = {
  filename: DB_FILENAME,
  schemaVersion: SCHEMA_VERSION,
  reconcileDialect: duckdbDialect,
  connect,
  close,
  // "Conflicting lock is held in <exe> (PID n)": duckdb's file lock spans the connection's life.
  isLocked: (err) => /Could not set lock on file/.test(err.message),
  ensureSchema,
  createStore: (handle, conn) => createStore(handle.instance, handle.duckdb, conn),
};

export async function openDuckdb(cfg: ResolvedConfig): Promise<OpenResult> {
  return openWithDialect(cfg, duckdbOpenDialect);
}
