// The Node floor (>=22.20) is explained here and nowhere else: 22.20 is the first release with
// both FTS5 and row-returning INSERT ... RETURNING. Raise it only for a load-bearing capability.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { contentTokenize, featureSignature, STATE_DIR } from '../../config/index.ts';
import { rekeyChunkText } from '../../embed/handoff.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { clearCache } from '../cache.ts';
import { getMeta, setMeta } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection, Store } from '../types.ts';
import { createConnection } from './connection.ts';
import { changedSignatureKeys, embedIdentityAdopted, rebuildContentTable, reconcile, signatureDiff } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`. Bumping it rebuilds
// existing trees on first query.
export const SCHEMA_VERSION = '18';

interface ConnectResult {
  db: DatabaseSync;
  conn: Connection;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

export interface OpenResult {
  store: Store;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

// unicode61 splits on spaces, so a language written without them indexes a whole run as one
// token and word search finds nothing; `content.tokenize` is how such a tree picks trigram.
const DEFAULT_TOKENIZE = 'porter unicode61';

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
async function ensureSchema(conn: Connection, cfg: Config, tokenize: string): Promise<void> {
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

async function connect(cfg: ResolvedConfig): Promise<ConnectResult> {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  const db = new DatabaseSync(dbPath);
  // A throw below must release this handle, or on Windows the leaked WAL db is undeletable and
  // scratch cleanup fails with EPERM/EBUSY. `closed` keeps the catch from double-closing.
  let closed = false;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    // Covers a concurrent watcher's bulk reconcile (~5s for 500 files at 26k notes). A query
    // that outwaits it still fails loudly.
    db.exec('PRAGMA busy_timeout = 30000');
    registerFunctions(db, contentTokenize(cfg) === undefined);
    const conn = createConnection(db);

    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

    // Before the rebuild branch below, never after: that branch deletes the cache, so a typo'd
    // tokenizer validated later would cost a full re-index (and re-embed) to reach its own error.
    const tokenize = resolveTokenize(db, cfg);

    // Schema-version or feature-set mismatch: reconcile only reparses changed files, so an
    // old cache can't be patched incrementally -- rebuild instead (cheap: nothing expensive lives here).
    const version = await getMeta(conn, 'schema_version');
    const features = await getMeta(conn, 'features');
    const wantFeatures = featureSignature(cfg, FEATURES);
    let tokenizeOnlyRebuild = false;
    if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
      // Indexing derives from presets, so a config edit rebuilding the cache must say so and
      // name what changed -- silent rebuilds make derived indexing look like a hang or a bug.
      if (version !== null && version !== SCHEMA_VERSION) {
        console.error('sense: cache format changed (new sensemaking version); rebuilding the index');
        closed = true;
        db.close();
        clearCache(cfg);
        return connect(cfg);
      }
      const changedKeys = changedSignatureKeys(features ?? '', wantFeatures);
      // Only the tokenizer moved, and frontmatter, links, sections and embeddings are file-derived
      // and tokenizer-independent. Any other signature change takes the full clear/reopen below.
      if (changedKeys.size === 1 && changedKeys.has('tokenize')) {
        console.error('sense: config change (content tokenizer) rebuilds the text index; vectors, links, and sections are kept');
        // One transaction, so a crash before COMMIT rolls back to the old tokenizer's table rather
        // than to no table. IF EXISTS makes a retry after such a crash a no-op, not a raw error.
        await withTransaction(conn, async () => {
          await conn.exec('DROP TABLE IF EXISTS content');
          await createContentTable(conn, tokenize);
        });
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
        db.close();
        clearCache(cfg);
        return connect(cfg);
      }
    }

    // Meta can lie after a crash between table creation and the signature write; the table's own
    // DDL cannot, so a mismatch here rebuilds whatever meta says.
    const stored = storedTokenize(db);
    if (stored !== null && stored !== tokenize) {
      console.error('sense: cache was built with a different content tokenizer; rebuilding the index');
      closed = true;
      db.close();
      clearCache(cfg);
      return connect(cfg);
    }

    await ensureSchema(conn, cfg, tokenize);

    let rebuildWarnings: string[] = [];
    if (tokenizeOnlyRebuild) {
      rebuildWarnings = await rebuildContentTable(conn, cfg, cfg.baseDir);
      await setMeta(conn, 'features', wantFeatures);
    }

    // 3x the largest reconcile this cache has recorded, floored at 30s and capped at 10min.
    // Installed before reconcile() -- that call is the one that races a watcher's transaction.
    const recordedMaxMs = Number((await getMeta(conn, 'reconcile_max_ms')) ?? '0');
    db.exec(`PRAGMA busy_timeout = ${Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000)}`);

    const { parsed, warnings } = await reconcile(conn, cfg, cfg.baseDir);

    return { db, conn, cfg, dbPath, parsed, warnings: [...rebuildWarnings, ...warnings] };
  } catch (err) {
    if (!closed) db.close();
    throw err;
  }
}

// The sqlite store's open: connects synchronously (see connect() above), then wraps the
// resulting connection in the async Store interface.
export async function openSqlite(cfg: ResolvedConfig): Promise<OpenResult> {
  const { db, conn, cfg: resolvedCfg, dbPath, parsed, warnings } = await connect(cfg);
  const store = createStore(db, conn, resolvedCfg, resolvedCfg.baseDir);
  // reconcile ran before this object existed, so its chunk text is keyed by the connection.
  rekeyChunkText(conn, store);
  return { store: store, cfg: resolvedCfg, dbPath, parsed, warnings };
}

export async function docCount(store: Store): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return ((await stmt.get()) as { n: number }).n;
}
