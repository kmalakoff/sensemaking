// The Node floor (>=22.20) is explained here and nowhere else: 22.20 is the first release with
// both FTS5 and row-returning INSERT ... RETURNING. Raise it only for a load-bearing capability.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from './config.ts';
import { contentTokenize, featureSignature, STATE_DIR } from './config.ts';
import { SenseError } from './errors.ts';
import { activeFeatures } from './features/index.ts';
import type { ReconcileDelta } from './features/types.ts';
import { progress } from './progress.ts';
import type { ParsedDoc } from './scan.ts';
import { listFiles, parseFile, RESERVED_COLUMNS } from './scan.ts';
import { segmentField, segmentMatch } from './segment.ts';

// Feature-owned columns (`_rank`) must stay out of the upsert: a reparse would null the last
// computed value on every touch, not just the reconciles that recompute it.
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_size', '_parse_error']);

// Rows -> SQLite: core schema, reconcile loop, has(). Parsing lives in scan.ts;
// everything beyond frontmatter + content lives in src/features/.

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`. Bumping it rebuilds
// existing trees on first query.
export const SCHEMA_VERSION = '12';

// SQLite's compile-time SQLITE_MAX_COLUMN, default 2000 (https://www.sqlite.org/limits.html).
const MAX_FRONTMATTER_COLUMNS = 2000;

export interface OpenResult {
  db: DatabaseSync;
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
}

function quoteIdent(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

// has(field, value): JSON-array field -> membership, string field -> substring, NULL -> false.
function registerFunctions(db: DatabaseSync): void {
  db.function('has', { deterministic: true, varargs: false }, (field: unknown, value: unknown): number => {
    if (field === null || field === undefined) return 0;

    const needle = String(value);

    if (typeof field === 'string') {
      if (field.startsWith('[')) {
        try {
          const parsed = JSON.parse(field);
          if (Array.isArray(parsed)) {
            return parsed.some((item) => String(item) === needle) ? 1 : 0;
          }
        } catch {}
      }
      return field.includes(needle) ? 1 : 0;
    }

    return String(field).includes(needle) ? 1 : 0;
  });

  // Raw `content MATCH '<unspaced text>'` cannot be rewritten behind the author's back, and
  // matches nothing, so the same transform is available to hand-written SQL by name. Whether
  // sidecars exist is read from meta, not config, lazily and cached: registerFunctions runs
  // before meta exists on a fresh db, so the read cannot happen here at registration time.
  let segmented: boolean | undefined;
  db.function('segment', { deterministic: true, varargs: false }, (terms: unknown): string => {
    const text = terms === null || terms === undefined ? '' : String(terms);
    if (segmented === undefined) segmented = getMeta(db, 'segmented') === '1';
    return segmented ? segmentMatch(text) : text;
  });
}

function getColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
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
function ensureSchema(db: DatabaseSync, cfg: Config, tokenize: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_size" INTEGER, "_parse_error" TEXT)`);
  // IF NOT EXISTS is safe against a tokenizer change: open() compares the table's own DDL
  // against the resolved tokenizer before this runs, so a stale table is already gone by now.
  // The three `_seg` sidecars are appended after path, never inserted: bm25(content, ...) and
  // snippet(content, 2, ...) are documented against the first three columns and keep working
  // (FTS5 defaults the weights it was not given). Each carries its field's exploded unspaced
  // runs for text that needs it, and an empty string for text that does not.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = '${tokenize}')`);
  // Coverage, not ownership: a path can appear under several presets. path leads the PK so the
  // per-doc delete is an index hit -- keyed the other way, cold builds went quadratic.
  db.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  db.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  for (const feature of activeFeatures(cfg)) feature.schema(db);
  if (getMeta(db, 'schema_version') === null) setMeta(db, 'schema_version', SCHEMA_VERSION);
  if (getMeta(db, 'features') === null) setMeta(db, 'features', featureSignature(cfg));
  // The one source of truth the query side reads (segment() in registerFunctions, and search()
  // in commands.ts): never gated on config directly, so index and query can't desync. Written
  // unconditionally so a tokenize-only rebuild (see open()) leaves it correct too.
  setMeta(db, 'segmented', contentTokenize(cfg) === undefined ? '1' : '0');
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: DatabaseSync, key: string, value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    return;
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Shared by reconcile() and the tokenize-only rebuild in open(), so content population is
// defined once. Assumes the frontmatter row for doc.relPath already exists (rowid lookup).
function insertContentRow(insertBody: StatementSync, doc: ParsedDoc, segmenting: boolean): void {
  insertBody.run(doc.relPath, doc.search.title, doc.search.summary, doc.search.text, doc.relPath, segmenting ? segmentField(doc.search.title) : '', segmenting ? segmentField(doc.search.summary) : '', segmenting ? segmentField(doc.search.text) : '');
}

export function docCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number };
  return row.n;
}

export function reconcile(db: DatabaseSync, cfg: Config, baseDir: string): { parsed: number; warnings: string[] } {
  const files = listFiles(cfg, baseDir);
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingRows = db.prepare(`SELECT "path", "_mtime", "_size" FROM frontmatter`).all() as Array<{
    path: string;
    _mtime: number;
    _size: number;
  }>;
  const existing = new Map(existingRows.map((r) => [r.path, r]));
  const vanished = existingRows.filter((r) => !currentSet.has(r.path)).map((r) => r.path);

  const toReparse = files.filter((f) => {
    const row = existing.get(f.relPath);
    return !row || row._mtime !== f.mtimeMs || row._size !== f.size;
  });

  if (vanished.length === 0 && toReparse.length === 0) return { parsed: 0, warnings: [] };

  const features = activeFeatures(cfg);
  const seenColumns = getColumns(db);
  const newColumns: string[] = [];
  const parsedDocs: ParsedDoc[] = [];
  const warnings: string[] = [];

  // Bulk reparses (a sync, a cold build) are the long silences a query can hit; short
  // reconciles stay silent (progress() has a threshold).
  const report = progress('reparsing files', toReparse.length);
  let parsedCount = 0;
  for (const file of toReparse) {
    // A doc only gets extract/store from features that apply to it (currently: embed, via
    // FileStat.embed -- true iff the config names an embedding model).
    const fileFeatures = features.filter((feature) => !feature.enabledForFile || feature.enabledForFile(cfg, file));
    const { doc, warnings: fileWarnings } = parseFile(file, fileFeatures);
    report.tick(++parsedCount);
    warnings.push(...fileWarnings);
    for (const key of Object.keys(doc.data)) {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        newColumns.push(key);
      }
    }
    parsedDocs.push(doc);
  }
  report.finish();

  const allColumns = [...seenColumns];
  // Fence before ALTERing: SQLite's own failure past this point is a raw
  // "too many columns on sqlite_altertab_frontmatter" with no indication of the boundary or the levers.
  if (allColumns.length > MAX_FRONTMATTER_COLUMNS) {
    throw new SenseError(
      'COLUMN_LIMIT',
      `frontmatter would need ${allColumns.length} columns, crossing SQLite's compile-time SQLITE_MAX_COLUMN limit (default ${MAX_FRONTMATTER_COLUMNS}; see https://www.sqlite.org/limits.html). Narrow the presets' include globs so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
    );
  }
  // Columns the frontmatter upsert actually writes: core + parsed frontmatter keys, never a
  // feature-owned reserved column (see CORE_FRONTMATTER_COLUMNS above).
  const writableColumns = allColumns.filter((c) => CORE_FRONTMATTER_COLUMNS.has(c) || !RESERVED_COLUMNS.has(c));
  // ON CONFLICT UPDATE (not OR REPLACE) keeps the row's rowid stable across reparses --
  // content rows are coupled to that rowid below.
  const insertSql = `INSERT INTO frontmatter (${writableColumns.map(quoteIdent).join(', ')}) VALUES (${writableColumns.map(() => '?').join(', ')}) ON CONFLICT("path") DO UPDATE SET ${writableColumns
    .filter((c) => c !== 'path')
    .map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)
    .join(', ')}`;

  const added = toReparse.filter((f) => !existing.has(f.relPath)).map((f) => f.relPath);
  const delta: ReconcileDelta = { files, reparsed: parsedDocs.map((d) => d.relPath), added, vanished };

  const txStart = Date.now();
  db.exec('BEGIN');
  try {
    for (const col of newColumns) db.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)}`);
    // FTS5 has no upsert, so delete-before-insert into `content`; coupled to the
    // frontmatter rowid (indexed via its PRIMARY KEY) instead of the UNINDEXED `path`
    // column, which a per-row DELETE would otherwise scan the whole table to find.
    const delBody = db.prepare(`DELETE FROM content WHERE rowid = (SELECT rowid FROM frontmatter WHERE "path" = ?)`);
    const delPresetFiles = db.prepare(`DELETE FROM preset_files WHERE "path" = ?`);
    const insertPresetFile = db.prepare(`INSERT INTO preset_files ("path", preset) VALUES (?, ?)`);
    if (vanished.length > 0) {
      const del = db.prepare(`DELETE FROM frontmatter WHERE "path" = ?`);
      for (const path of vanished) {
        // content delete must run first: it looks up the frontmatter rowid by path, which
        // the frontmatter delete below would otherwise have already removed.
        delBody.run(path);
        del.run(path);
        delPresetFiles.run(path);
        for (const feature of features) feature.remove?.(db, path, delta);
      }
    }
    if (parsedDocs.length > 0) {
      const insert = db.prepare(insertSql);
      const insertBody = db.prepare(`INSERT INTO content (rowid, title, summary, text, "path", title_seg, summary_seg, text_seg) VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?, ?, ?, ?)`);
      // A non-default tokenizer means the tree has chosen its own scheme; a phrase query over
      // grapheme runs would be nonsense against trigram, so the sidecars stay empty.
      const segmenting = contentTokenize(cfg) === undefined;
      for (const doc of parsedDocs) {
        const values = writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_size') return doc.size;
          // Written per parse, unlike _rank, which a feature pass owns and the upsert skips.
          if (col === '_parse_error') return doc.parseError;
          return doc.data[col] ?? null;
        });
        // Frontmatter upsert first: content's rowid lookup below depends on this row existing.
        insert.run(...values);
        // Only for docs that have rows: an unconditional delete made cold crawls quadratic.
        if (existing.has(doc.relPath)) {
          delBody.run(doc.relPath);
          for (const feature of features) feature.remove?.(db, doc.relPath, delta);
        }
        insertContentRow(insertBody, doc, segmenting);
        // A preset edit forces a full rebuild, so an unchanged doc's coverage is already
        // correct; new docs have nothing to clear, which keeps cold builds linear.
        if (existing.has(doc.relPath)) delPresetFiles.run(doc.relPath);
        for (const presetName of doc.presets) insertPresetFile.run(doc.relPath, presetName);
        for (const feature of features) feature.store?.(db, doc.relPath, doc.extracted[feature.name], delta);
      }
    }
    for (const feature of features) feature.afterReconcile?.(db, delta);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Reconcile's own write-transaction duration, for open()'s derived busy_timeout (F):
  // keep the observed max so a big watcher reconcile's lock hold is what the next open bounds its wait against.
  const durationMs = Date.now() - txStart;
  const prevRaw = getMeta(db, 'reconcile_max_ms');
  // -1, not 0, so a genuinely 0ms first reconcile (sub-millisecond, common on a tiny tree)
  // still gets recorded instead of losing to the "nothing recorded yet" default.
  const prevMax = prevRaw === null ? -1 : Number(prevRaw);
  if (durationMs > prevMax) setMeta(db, 'reconcile_max_ms', String(durationMs));

  return { parsed: parsedDocs.length, warnings };
}

// Segment keys that moved between two feature signatures (see config.featureSignature's
// format: global features, embed provider, tokenize, then one segment per preset).
function changedSignatureKeys(before: string, after: string): Set<string> {
  const keyOf = (part: string) => (part.startsWith('preset:') ? part.split(':').slice(0, 2).join(':') : part.split(':')[0]);
  const parse = (sig: string) => new Map(sig.split('|').map((part) => [keyOf(part), part]));
  const a = parse(before);
  const b = parse(after);
  const changed = new Set<string>();
  for (const [key, val] of b) if (a.get(key) !== val) changed.add(key);
  for (const key of a.keys()) if (!b.has(key)) changed.add(key);
  return changed;
}

// Names what moved, for the rebuild notice.
function signatureDiff(before: string, after: string): string {
  const changed = changedSignatureKeys(before, after);
  const label = (key: string) => (key === 'embed' ? 'embed settings' : key === 'tokenize' ? 'content tokenizer' : key.startsWith('preset:') ? `preset "${key.slice(7)}"` : 'features');
  return changed.size === 0 ? 'features' : [...changed].map(label).join(', ');
}

// The tokenize-only rebuild in open(): content is dropped and repopulated from files already
// listed in frontmatter, which itself is untouched. Frontmatter, links, sections, and
// embeddings are file-derived and tokenizer-independent, so they survive. No feature extractors
// run here -- doc.search (title/summary/text) is all content population needs.
function rebuildContentTable(db: DatabaseSync, cfg: Config, baseDir: string): void {
  const known = new Set((db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path));
  const files = listFiles(cfg, baseDir).filter((f) => known.has(f.relPath));
  const segmenting = contentTokenize(cfg) === undefined;
  const insertBody = db.prepare(`INSERT INTO content (rowid, title, summary, text, "path", title_seg, summary_seg, text_seg) VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    for (const file of files) {
      const { doc } = parseFile(file);
      insertContentRow(insertBody, doc, segmenting);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function open(cfg: ResolvedConfig): OpenResult {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Covers a concurrent watcher's bulk reconcile (~5s for 500 files at 26k notes). A query
  // that outwaits it still fails loudly.
  db.exec('PRAGMA busy_timeout = 30000');
  registerFunctions(db);

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // Before the rebuild branch below, never after: that branch deletes the cache, so a typo'd
  // tokenizer validated later would cost a full re-index (and re-embed) to reach its own error.
  const tokenize = resolveTokenize(db, cfg);

  // Schema-version or feature-set mismatch: reconcile only reparses changed files, so an
  // old cache can't be patched incrementally -- rebuild instead (cheap: nothing expensive lives here).
  const version = getMeta(db, 'schema_version');
  const features = getMeta(db, 'features');
  const wantFeatures = featureSignature(cfg);
  if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
    // Indexing derives from presets, so a config edit rebuilding the cache must say so and
    // name what changed -- silent rebuilds make derived indexing look like a hang or a bug.
    if (version !== null && version !== SCHEMA_VERSION) {
      console.error('sense: cache format changed (new sensemaking version); rebuilding the index');
      db.close();
      clearCache(cfg);
      return open(cfg);
    }
    const changedKeys = changedSignatureKeys(features ?? '', wantFeatures);
    // Only the tokenizer moved: frontmatter, links, sections, and embeddings are file-derived
    // and tokenizer-independent, so they don't need re-deriving. Everything else -- a preset
    // edit, an embed model change -- still takes the full clear/reopen below.
    if (changedKeys.size === 1 && changedKeys.has('tokenize')) {
      console.error('sense: config change (content tokenizer) rebuilds the text index; vectors, links, and sections are kept');
      db.exec('DROP TABLE content');
      ensureSchema(db, cfg, tokenize);
      rebuildContentTable(db, cfg, cfg.baseDir);
      setMeta(db, 'features', wantFeatures);
    } else {
      const changed = signatureDiff(features ?? '', wantFeatures);
      console.error(`sense: config change (${changed}) rebuilds the index`);
      db.close();
      clearCache(cfg);
      return open(cfg);
    }
  }

  // Meta can lie after a crash between table creation and the signature write; the table's
  // own DDL cannot. A mismatch here rebuilds no matter what meta says.
  const stored = storedTokenize(db);
  if (stored !== null && stored !== tokenize) {
    console.error('sense: cache was built with a different content tokenizer; rebuilding the index');
    db.close();
    clearCache(cfg);
    return open(cfg);
  }

  ensureSchema(db, cfg, tokenize);

  // 3x the largest reconcile this cache has recorded, floored at 30s and capped at 10min.
  // Installed before reconcile() -- that call is the one that races a watcher's transaction.
  const recordedMaxMs = Number(getMeta(db, 'reconcile_max_ms') ?? '0');
  db.exec(`PRAGMA busy_timeout = ${Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000)}`);

  const { parsed, warnings } = reconcile(db, cfg, cfg.baseDir);

  return { db, cfg, dbPath, parsed, warnings };
}

// Deletes the cache directory, and only that. The rebuild is not this function's job: the next
// open() reconciles, which is what running any command already does, so a verb that bundled the
// two described the half that was not its own. Manual reset for a doubted cache; the schema and
// config-signature mismatches below reset themselves.
export function clearCache(cfg: ResolvedConfig): void {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
}
