import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '@tursodatabase/database';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { featureSignature, STATE_DIR } from '../../config/index.ts';
import { rekeyChunkText } from '../../embed/handoff.ts';
import { STORE_DIMS } from '../../embed/types.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { clearCache } from '../cache.ts';
import { reconcile } from '../reconcile.ts';
import { getMeta, setMeta } from '../shared.ts';
import type { Connection, Store } from '../types.ts';
import { createConnection } from './connection.ts';
import { TURSO_PACKAGE, tursoApi } from './native.ts';
import { tursoDialect } from './reconcile.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.turso.db';
// Independent of sqlite's and duckdb's SCHEMA_VERSION: each store's cache shape evolves
// separately. Covers the FTS indexes, the "_ngram" sidecar columns, and embeddings.vector's width.
export const SCHEMA_VERSION = '3';

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

// The ngram index is scoped to disjoint "_ngram" sidecar columns: a second index over the same
// columns makes a bare substring match a whole word, defeating the prefix-query rejection.
// The two FTS indexes, named here because reconcile drops and rebuilds them around a bulk load:
// Tantivy maintains them per inserted row, which is quadratic in what is already indexed.
export const CONTENT_FTS_DDL = [
  `CREATE INDEX IF NOT EXISTS content_fts ON content USING fts (title, summary, text) WITH (weights = 'title=10.0,summary=5.0,text=1.0')`,
  `CREATE INDEX IF NOT EXISTS content_fts_ngram ON content USING fts (title_ngram, summary_ngram, text_ngram) WITH (tokenizer='ngram', weights='title_ngram=10.0,summary_ngram=5.0,text_ngram=1.0')`,
] as const;
export const CONTENT_FTS_NAMES = ['content_fts', 'content_fts_ngram'] as const;

async function ensureSchema(conn: Connection, cfg: Config): Promise<void> {
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
  // A throw below must release this handle, or the leaked WAL makes the db file undeletable on
  // Windows. closed guards the catch against double-closing.
  let closed = false;
  try {
    const conn = createConnection(db);

    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    const version = await getMeta(conn, 'schema_version');
    const features = await getMeta(conn, 'features');
    const wantFeatures = featureSignature(cfg, FEATURES);
    if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
      // Reconcile only reparses changed files, so a stale cache is rebuilt rather than patched
      // incrementally. No tokenize-only or embed-identity-adopted partial path: any mismatch rebuilds.
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

    const { parsed, warnings } = await reconcile(conn, cfg, cfg.baseDir, tursoDialect);

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
  const store = createStore(db, conn, resolvedCfg, resolvedCfg.baseDir);
  // reconcile ran before this object existed, so its chunk text is keyed by the connection.
  rekeyChunkText(conn, store);
  return { store: store, cfg: resolvedCfg, dbPath, parsed, warnings };
}
