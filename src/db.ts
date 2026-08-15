import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from './config.ts';
import { featureSignature, STATE_DIR } from './config.ts';
import { SenseError } from './errors.ts';
import { activeFeatures } from './features/index.ts';
import type { ReconcileDelta } from './features/types.ts';
import { progress } from './progress.ts';
import type { ParsedDoc } from './scan.ts';
import { listFiles, parseFile, RESERVED_COLUMNS } from './scan.ts';

// path/_mtime/_size are core: every reparse legitimately rewrites them. Every other
// RESERVED_COLUMNS entry that shows up as a real frontmatter column (currently only
// rank's `_rank`) is feature-owned -- scan.ts already refuses to let frontmatter set it,
// so it must never appear in the upsert below, or a reparse would blow its last computed
// value away with NULL on every touch, not just the reconciles that recompute it.
const CORE_FRONTMATTER_COLUMNS = new Set(['path', '_mtime', '_size']);

// Rows -> SQLite: core schema, reconcile loop, has(). Parsing lives in scan.ts;
// everything beyond frontmatter + content lives in src/features/.

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`.
// 5: frontmatter upsert is ON CONFLICT UPDATE (was OR REPLACE) so rowid is stable, and
// content is coupled to that rowid instead of an UNINDEXED path column (was: 4 -- scalars
// store as INTEGER/REAL/TEXT by YAML type).
export const SCHEMA_VERSION = '5';

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
}

function getColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

// Content is a separate table (not a column on frontmatter) so `SELECT * FROM frontmatter`
// can't dump file text into context. Features add their own tables after the core ones.
function ensureSchema(db: DatabaseSync, cfg: Config): void {
  db.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_size" INTEGER)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, tokenize = 'porter unicode61')`);
  for (const feature of activeFeatures(cfg)) feature.schema(db);
  if (getMeta(db, 'schema_version') === null) setMeta(db, 'schema_version', SCHEMA_VERSION);
  if (getMeta(db, 'features') === null) setMeta(db, 'features', featureSignature(cfg));
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
    const { doc, warnings: fileWarnings } = parseFile(file, features);
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
      `frontmatter would need ${allColumns.length} columns, crossing SQLite's compile-time SQLITE_MAX_COLUMN limit (default ${MAX_FRONTMATTER_COLUMNS}; see https://www.sqlite.org/limits.html). Narrow scan.include so fewer/other files are indexed, or fix whatever is generating unbounded frontmatter keys.`
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
    if (vanished.length > 0) {
      const del = db.prepare(`DELETE FROM frontmatter WHERE "path" = ?`);
      for (const path of vanished) {
        // content delete must run first: it looks up the frontmatter rowid by path, which
        // the frontmatter delete below would otherwise have already removed.
        delBody.run(path);
        del.run(path);
        for (const feature of features) feature.remove?.(db, path, delta);
      }
    }
    if (parsedDocs.length > 0) {
      const insert = db.prepare(insertSql);
      const insertBody = db.prepare(`INSERT INTO content (rowid, title, summary, text, "path") VALUES ((SELECT rowid FROM frontmatter WHERE "path" = ?), ?, ?, ?, ?)`);
      for (const doc of parsedDocs) {
        const values = writableColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_size') return doc.size;
          return doc.data[col] ?? null;
        });
        // Frontmatter upsert first: content's rowid lookup below depends on this row existing.
        insert.run(...values);
        // Delete-before-insert only for docs that have rows: an FTS5 DELETE by rowid on a
        // cold build (empty table, nothing to delete) is wasted work, and doing it
        // unconditionally previously made the crawl quadratic when it scanned by column --
        // measured 4x time per note-count doubling at 13k/26k notes.
        if (existing.has(doc.relPath)) {
          delBody.run(doc.relPath);
          for (const feature of features) feature.remove?.(db, doc.relPath, delta);
        }
        insertBody.run(doc.relPath, doc.search.title, doc.search.summary, doc.search.text, doc.relPath);
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

export function open(cfg: ResolvedConfig): OpenResult {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Covers a concurrent watcher's bulk reconcile: the write transaction for 500 changed
  // files measures ~5s at 26k notes, so 5s expired exactly at the boundary and queries
  // racing the watcher got SQLITE_BUSY. 30s bounds the wait at ~3x the largest measured
  // reconcile; a query that outwaits it still fails loudly.
  db.exec('PRAGMA busy_timeout = 30000');
  registerFunctions(db);

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // Schema-version or feature-set mismatch: reconcile only reparses changed files, so an
  // old cache can't be patched incrementally -- rebuild instead (cheap: nothing expensive lives here).
  const version = getMeta(db, 'schema_version');
  const features = getMeta(db, 'features');
  const wantFeatures = featureSignature(cfg);
  if ((version !== null && version !== SCHEMA_VERSION) || (features !== null && features !== wantFeatures)) {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
    return open(cfg);
  }

  ensureSchema(db, cfg);

  // Derived from reconcile's own recorded max (F): 3x the largest reconcile this cache has
  // ever held its write transaction for, floored at the 30s default and capped at 10min so
  // one pathological build can't pin every later open to an unbounded wait. Installed
  // before reconcile() below -- this open's own reconcile is exactly the operation that
  // races a concurrent watcher's transaction and needs the derived wait.
  const recordedMaxMs = Number(getMeta(db, 'reconcile_max_ms') ?? '0');
  db.exec(`PRAGMA busy_timeout = ${Math.min(Math.max(30000, 3 * recordedMaxMs), 600_000)}`);

  const { parsed, warnings } = reconcile(db, cfg, cfg.baseDir);

  return { db, cfg, dbPath, parsed, warnings };
}

// Manual reset for a doubted cache.
export function rebuild(cfg: ResolvedConfig): OpenResult {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
  return open(cfg);
}
