// The Node floor (>=22.20) is explained here and nowhere else: 22.20 is the first release with
// both FTS5 and row-returning INSERT ... RETURNING. Raise it only for a load-bearing capability.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { contentTokenize, featureSignature, STATE_DIR } from '../../config/index.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures, FEATURES } from '../../features/index.ts';
import { getMeta, setMeta } from '../shared.ts';
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

// Stemming is English-only, but the segmentation underneath it is what decides coverage:
// unicode61 splits on spaces, so a language written without them (Chinese, Japanese, Thai)
// indexes a whole run as one token and word search finds nothing. `content.tokenize` is how
// such a tree picks trigram instead.
const DEFAULT_TOKENIZE = 'porter unicode61';

// FTS5 takes its tokenizer as a string literal inside DDL, where nothing can bind, so a
// configured value has to be concatenated. Probing a throwaway table is what makes that safe
// and is also the whole validation: anything the linked SQLite accepts passes, anything else
// fails here with SQLite's own message rather than against the real table. It means no table
// of which version added which tokenizer has to be maintained.
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

// Content is a separate table (not a column on frontmatter) so `SELECT * FROM frontmatter`
// can't dump file text into context. Features add their own tables after the core ones.
async function ensureSchema(conn: Connection, cfg: Config, tokenize: string): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_ctime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  // IF NOT EXISTS is safe against a tokenizer change: open() compares the table's own DDL
  // against the resolved tokenizer before this runs, so a stale table is already gone by now.
  // The three `_seg` sidecars are appended after path, never inserted: bm25(content, ...) and
  // snippet(content, 2, ...) are documented against the first three columns and keep working
  // (FTS5 defaults the weights it was not given). Each carries its field's exploded unspaced
  // runs for text that needs it, and an empty string for text that does not.
  await conn.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = '${tokenize}')`);
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
  // A throw below (tokenizer probe, schema, reconcile's COLUMN_LIMIT) must release this handle,
  // or on Windows the leaked WAL db is undeletable and scratch cleanup fails with EPERM/EBUSY.
  // closed marks the rebuild branches that close-and-recurse, so the catch never double-closes.
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
      // Only the tokenizer moved: frontmatter, links, sections, and embeddings are file-derived
      // and tokenizer-independent, so they don't need re-deriving. Everything else -- a preset
      // edit, an embed model change -- still takes the full clear/reopen below.
      if (changedKeys.size === 1 && changedKeys.has('tokenize')) {
        console.error('sense: config change (content tokenizer) rebuilds the text index; vectors, links, and sections are kept');
        db.exec('DROP TABLE content');
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

    // Meta can lie after a crash between table creation and the signature write; the table's
    // own DDL cannot. A mismatch here rebuilds no matter what meta says. A tokenize-only rebuild
    // just dropped content above, so storedTokenize sees no table and this guard is skipped
    // naturally rather than needing its own case.
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
  return { store: createStore(db, conn, resolvedCfg, resolvedCfg.baseDir), cfg: resolvedCfg, dbPath, parsed, warnings };
}

export async function docCount(store: Store): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return ((await stmt.get()) as { n: number }).n;
}

// Deletes the cache directory, and only that. The rebuild is not this function's job: the next
// open() reconciles, which is what running any command already does, so a verb that bundled the
// two described the half that was not its own. Manual reset for a doubted cache; the schema and
// config-signature mismatches below reset themselves.
export function clearCache(cfg: ResolvedConfig): void {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
}
