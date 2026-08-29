import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { featureSignature, STATE_DIR } from '../../config/index.ts';
import { STORE_DIMS } from '../../embed/types.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { getMeta, setMeta } from '../shared.ts';
import { clearCache } from '../sqlite/open.ts';
import type { Connection, Store } from '../types.ts';
import { createConnection } from './connection.ts';
import { DUCKDB_PACKAGE, duckdbApi } from './native.ts';
import { reconcile } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.duckdb';
// Independent of sqlite's SCHEMA_VERSION -- the two stores' cache shapes evolve separately
// (VARIANT frontmatter columns instead of untyped ones), and the store name already joins the
// feature signature (see featureSignature), so a config's `store` key switching cleanly
// rebuilds rather than reusing the other engine's stale cache shape.
export const SCHEMA_VERSION = '2';

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

// `content` is a plain table (not FTS-virtual): D1 builds DuckDB's fts index over it lazily,
// only when a lexical query actually runs (see duckdb/lexical.ts), and reads it directly for
// contains() substring/phrase/unspaced-script verification either way. No tokenizer resolution
// -- this store always uses the fts extension's default (porter) stemmer, unlike sqlite's
// configurable `content.tokenize` (not read here; D1 does not extend that knob to DuckDB).
async function ensureSchema(conn: Connection, cfg: Config): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" DOUBLE, "_ctime" DOUBLE, "_size" INTEGER, "_parse_error" TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) {
    // Native FLOAT[STORE_DIMS] instead of the embed feature's engine-neutral BLOB+scale DDL
    // (see duckdb/vectors.ts). `scale` is kept, unused, so the feature's shared reconcile-time
    // INSERT/DELETE (src/features/embed.ts) still names a column that exists on both stores.
    if (feature.name === 'embed') {
      await conn.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector FLOAT[${STORE_DIMS}], PRIMARY KEY ("path", chunk))`);
      continue;
    }
    await feature.schema(conn);
  }
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
  if ((await getMeta(conn, 'features')) === null) await setMeta(conn, 'features', featureSignature(cfg, FEATURES));
}

async function connect(cfg: ResolvedConfig): Promise<{ instance: DuckDBInstance; duckdb: DuckDBConnection; conn: Connection; cfg: ResolvedConfig; dbPath: string; parsed: number; warnings: string[] }> {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  // Dynamic, not a top-level import: sqlite trees must never even attempt to resolve this
  // optional peer dependency, so nothing in this store's module graph imports it as a value
  // until a duckdb tree is actually opened (types-only imports elsewhere are erased and cost
  // nothing either way). Installed on first use if missing, and shared with sql-functions.ts
  // and vectors.ts (see native.ts's duckdbApi).
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
    // On-disk files default to an older storage format for cross-version compatibility, which
    // rejects VARIANT columns ("VARIANT columns are not supported in storage versions prior to
    // v1.5.0"); this store's dynamic frontmatter columns need VARIANT (see reconcile.ts), so
    // the format floor is pinned explicitly. :memory: databases are unaffected either way.
    instance = await DuckDBInstance.create(dbPath, { storage_compatibility_version: 'v1.5.0' });
    duckdb = await instance.connect();
  } catch (err) {
    // create() may have succeeded before connect() failed: close it, or its WAL stays open.
    instance?.closeSync();
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" failed to open ${dbPath}: ${(err as Error).message}`);
  }
  await registerFunctions(duckdb);
  const conn = createConnection(duckdb);

  await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  const version = await getMeta(conn, 'schema_version');
  const features = await getMeta(conn, 'features');
  const wantFeatures = featureSignature(cfg, FEATURES);
  if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
    // Reconcile only reparses changed files, so a stale cache can't be patched incrementally --
    // rebuild instead, same as sqlite's open() (see its comment for why this is announced).
    const reason = version !== null && version !== SCHEMA_VERSION ? 'cache format changed (new sensemaking version)' : 'config change (features, tokenizer, or presets)';
    console.error(`sense: ${reason}; rebuilding the index`);
    // Close before clearCache deletes the files underneath the still-open instance.
    duckdb.disconnectSync();
    instance.closeSync();
    clearCache(cfg);
    return connect(cfg);
  }

  await ensureSchema(conn, cfg);

  const { parsed, warnings } = await reconcile(conn, cfg, cfg.baseDir);
  return { instance, duckdb, conn, cfg, dbPath, parsed, warnings };
}

export async function openDuckdb(cfg: ResolvedConfig): Promise<OpenResult> {
  const { instance, duckdb, conn, cfg: resolvedCfg, dbPath, parsed, warnings } = await connect(cfg);
  return { store: createStore(instance, duckdb, conn, resolvedCfg, resolvedCfg.baseDir), cfg: resolvedCfg, dbPath, parsed, warnings };
}
