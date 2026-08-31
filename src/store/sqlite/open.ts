// The Node floor (>=22.20) is explained here and nowhere else: 22.20 is the first release with
// both FTS5 and row-returning INSERT ... RETURNING. Raise it only for a load-bearing capability.
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { contentTokenize, featureSignature } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { listFiles, parseFile } from '../../scan/index.ts';
import type { OpenResult } from '../open.ts';
import { openWithDialect } from '../open.ts';
import { getMeta, setMeta } from '../shared.ts';
import { BEGIN_WRITE, withTransaction } from '../transaction.ts';
import type { Connection, OpenDialect } from '../types.ts';
import { createConnection } from './connection.ts';
import { contentRow, INSERT_CONTENT_SQL, sqliteDialect } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`. Bumping it rebuilds
// existing trees on first query.
export const SCHEMA_VERSION = '19';

export type { OpenResult };

// unicode61 splits on spaces, so a language written without them indexes a whole run as one
// token and word search finds nothing; `content.tokenize` is how such a tree picks trigram.
const DEFAULT_TOKENIZE = 'porter unicode61';

// The connection plus this store's own extra state (types.ts's OpenDialect<Handle>): the
// resolved tokenizer, threaded through connect, the tokenize-only rebuild, and ensureSchema.
interface SqliteHandle {
  db: DatabaseSync;
  tokenize: string;
}

// FTS5 takes its tokenizer as a DDL string literal where nothing can bind, so the configured
// value is concatenated; probing a throwaway table first is both the safety and the validation.
function resolveTokenize(db: DatabaseSync, cfg: Config): string {
  const configured = contentTokenize(cfg);
  if (configured === undefined) return DEFAULT_TOKENIZE;
  const literal = configured.replace(/'/g, "''");
  try {
    db.exec('DROP TABLE IF EXISTS temp.sense_tokenize_probe');
    db.exec(`CREATE VIRTUAL TABLE temp.sense_tokenize_probe USING fts5(x, tokenize = '${literal}')`);
    db.exec('DROP TABLE IF EXISTS temp.sense_tokenize_probe');
  } catch (err) {
    throw new SenseError('CONFIG_INVALID', `content.tokenize "${configured}" is not a tokenizer this SQLite accepts (${(err as Error).message}); the built-in choices are unicode61, ascii, porter, and trigram, each with their own options`);
  }
  return literal;
}

// The tokenizer the content table was actually built with, from its own DDL -- the one
// record that cannot desynchronize from the table. NULL when the table does not exist yet.
function storedTokenize(db: DatabaseSync): string | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'content'`).get() as { sql: string } | undefined;
  if (!row) return null;
  const m = row.sql.match(/tokenize = '((?:[^']|'')*)'/);
  return m ? m[1] : null;
}

// The `_seg` sidecars are appended after path, never inserted: bm25() and snippet(content, 2)
// are documented against the first three columns. Each holds its field's exploded unspaced runs.
async function createContentTable(conn: Connection, tokenize: string): Promise<void> {
  await conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = '${tokenize}')`);
}

// Content is a separate table (not a column on frontmatter) so `SELECT * FROM frontmatter`
// can't dump file text into context. Features add their own tables after the core ones.
async function ensureSchemaTables(conn: Connection, cfg: Config, tokenize: string): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_ctime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  // IF NOT EXISTS is safe against a tokenizer change: open() compares the table's own DDL
  // against the resolved tokenizer before this runs, so a stale table is already gone by now.
  await createContentTable(conn, tokenize);
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

async function connect(dbPath: string, cfg: ResolvedConfig): Promise<{ handle: SqliteHandle; conn: Connection }> {
  const db = new DatabaseSync(dbPath);
  try {
    // Before journal_mode, not after: converting a fresh database to WAL takes a brief exclusive
    // lock, and with no timeout set yet a second process opening the same tree fails in 1ms.
    db.exec('PRAGMA busy_timeout = 30000');
    // busy_timeout does not cover the WAL conversion itself: SQLite does not invoke the busy
    // handler for it, so a concurrent cold open needs its own bounded wait.
    setJournalWal(db);
    registerFunctions(db, contentTokenize(cfg) === undefined);
    const conn = createConnection(db);
    // Before the rebuild branch below, never after: that branch deletes the cache, so a typo'd
    // tokenizer validated later would cost a full re-index (and re-embed) to reach its own error.
    const tokenize = resolveTokenize(db, cfg);
    return { handle: { db, tokenize }, conn };
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

// Only the tokenizer moved, and frontmatter, links, sections and embeddings are file-derived
// and tokenizer-independent. Any other signature change takes the full clear/reopen in open.ts.
async function partialRebuild(handle: SqliteHandle, conn: Connection, _cfg: Config, changedKeys: Set<string>): Promise<boolean> {
  if (!(changedKeys.size === 1 && changedKeys.has('tokenize'))) return false;
  console.error('sense: config change (content tokenizer) rebuilds the text index; vectors, links, and sections are kept');
  // One transaction, so a crash before COMMIT rolls back to the old tokenizer's table rather
  // than to no table. IF EXISTS makes a retry after such a crash a no-op, not a raw error.
  await withTransaction(
    conn,
    async () => {
      await conn.exec('DROP TABLE IF EXISTS content');
      await createContentTable(conn, handle.tokenize);
    },
    BEGIN_WRITE
  );
  return true;
}

// Tokenize-only rebuild: only `content` is repopulated (the other tables are tokenizer-independent)
// and no feature extractors run. Warnings come from the reparse, since mtimes stay untouched and reconcile would never reparse them.
async function postSchemaRebuild(_handle: SqliteHandle, conn: Connection, cfg: Config, baseDir: string, wantFeatures: string): Promise<string[]> {
  const stmt = await conn.prepare('SELECT "path" FROM frontmatter');
  const known = new Set(((await stmt.all()) as Array<{ path: string }>).map((r) => r.path));
  const files = listFiles(cfg, baseDir).filter((f) => known.has(f.relPath));
  const segmenting = contentTokenize(cfg) === undefined;
  const warnings: string[] = [];
  const rows: unknown[][] = [];
  for (const file of files) {
    const { doc, warnings: fileWarnings } = parseFile(file);
    warnings.push(...fileWarnings);
    rows.push(contentRow(doc, segmenting));
  }
  await withTransaction(
    conn,
    async () => {
      if (rows.length > 0) await conn.runBatch(INSERT_CONTENT_SQL, rows);
    },
    BEGIN_WRITE
  );
  await setMeta(conn, 'features', wantFeatures);
  return warnings;
}

// Meta can lie after a crash between table creation and the signature write; the table's own
// DDL cannot, so a mismatch here rebuilds whatever meta says.
function extraRebuildReason(handle: SqliteHandle): string | null {
  const stored = storedTokenize(handle.db);
  if (stored !== null && stored !== handle.tokenize) return 'cache was built with a different content tokenizer';
  return null;
}

async function ensureSchema(handle: SqliteHandle, conn: Connection, cfg: Config): Promise<void> {
  // One writer at a time: the feature hooks check a column then add it, so two cold opens racing
  // here both see it missing and the second ALTER fails with a duplicate column.
  await withTransaction(conn, () => ensureSchemaTables(conn, cfg, handle.tokenize), BEGIN_WRITE);
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
  partialRebuild,
  postSchemaRebuild,
  extraRebuildReason,
  ensureSchema,
  setDerivedBusyTimeout,
  createStore: (handle, conn, cfg) => createStore(handle.db, conn, cfg),
};

export async function openSqlite(cfg: ResolvedConfig): Promise<OpenResult> {
  return openWithDialect(cfg, sqliteOpenDialect);
}
