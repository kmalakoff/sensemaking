// The Node floor (>=22.20) is explained here and nowhere else: 22.20 is the first release with
// both FTS5 and row-returning INSERT ... RETURNING. Raise it only for a load-bearing capability.
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { featureSignature } from '../../config/index.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import type { OpenResult } from '../open.ts';
import { openWithDialect } from '../open.ts';
import { getMeta, setMeta } from '../shared.ts';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection, OpenDialect } from '../types.ts';
import { createConnection } from './connection.ts';
import { sqliteDialect } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`. Bumping it rebuilds
// existing trees on first query.
export const SCHEMA_VERSION = '20';

export type { OpenResult };

// unicode61 splits on spaces, so a language written without them indexes a whole run as one
// token and word search finds nothing; the `_seg` sidecars (always populated) cover that case.
const TOKENIZE = 'porter unicode61';

interface SqliteHandle {
  db: DatabaseSync;
}

// The `_seg` sidecars are appended after path, never inserted: bm25() and snippet(content, 2)
// are documented against the first three columns. Each holds its field's exploded unspaced runs.
async function createContentTable(conn: Connection): Promise<void> {
  await conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = '${TOKENIZE}')`);
}

// Content is a separate table (not a column on frontmatter) so `SELECT * FROM frontmatter`
// can't dump file text into context. Features add their own tables after the core ones.
async function ensureSchemaTables(conn: Connection, cfg: Config): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_ctime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  await createContentTable(conn);
  // Coverage, not ownership: a path can appear under several presets. path leads the PK so the
  // per-doc delete is an index hit -- keyed the other way, cold builds went quadratic.
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) await feature.schema(conn);
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
  if ((await getMeta(conn, 'features')) === null) await setMeta(conn, 'features', featureSignature(cfg, FEATURES));
}

// Two processes opening the same fresh tree both try to convert it, and the loser gets SQLITE_BUSY
// with no busy handler behind it. Bounded because a lock held past this is a real problem, not a race.
function setJournalWal(db: DatabaseSync): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (err) {
      if (Date.now() >= deadline || !/database is locked|busy/i.test((err as Error).message)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

async function connect(dbPath: string, _cfg: ResolvedConfig): Promise<{ handle: SqliteHandle; conn: Connection }> {
  const db = new DatabaseSync(dbPath);
  try {
    // Before journal_mode, not after: converting a fresh database to WAL takes a brief exclusive
    // lock, and with no timeout set yet a second process opening the same tree fails in 1ms.
    db.exec('PRAGMA busy_timeout = 30000');
    // busy_timeout does not cover the WAL conversion itself: SQLite does not invoke the busy
    // handler for it, so a concurrent cold open needs its own bounded wait.
    setJournalWal(db);
    registerFunctions(db);
    const conn = createConnection(db);
    return { handle: { db }, conn };
  } catch (err) {
    // A throw here must release this handle, or on Windows the leaked WAL db is undeletable and
    // scratch cleanup fails with EPERM/EBUSY.
    db.close();
    throw err;
  }
}

async function close(handle: SqliteHandle): Promise<void> {
  handle.db.close();
}

async function ensureSchema(_handle: SqliteHandle, conn: Connection, cfg: Config): Promise<void> {
  // One writer at a time: the feature hooks check a column then add it, so two cold opens racing
  // here both see it missing and the second ALTER fails with a duplicate column.
  await withTransaction(conn, () => ensureSchemaTables(conn, cfg), BEGIN_WRITE);
}

async function setDerivedBusyTimeout(handle: SqliteHandle, _conn: Connection, ms: number): Promise<void> {
  handle.db.exec(`PRAGMA busy_timeout = ${ms}`);
}

// This store's dialect (types.ts's OpenDialect) for the shared orchestration in store/open.ts.
export const sqliteOpenDialect: OpenDialect<SqliteHandle> = {
  filename: DB_FILENAME,
  schemaVersion: SCHEMA_VERSION,
  reconcileDialect: sqliteDialect,
  connect,
  close,
  ensureSchema,
  setDerivedBusyTimeout,
  createStore: (handle, conn) => createStore(handle.db, conn),
};

export async function openSqlite(cfg: ResolvedConfig): Promise<OpenResult> {
  return openWithDialect(cfg, sqliteOpenDialect);
}
