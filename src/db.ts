import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from './config.ts';
import { STATE_DIR } from './config.ts';
import type { ParsedDoc } from './scan.ts';
import { listFiles, parseFile } from './scan.ts';

// Rows -> SQLite: schema, reconcile, has(). Filesystem/frontmatter parsing lives in scan.ts.

export const DB_FILENAME = 'cache.db';
// Cache shape version, independent of the config's own `version`.
export const SCHEMA_VERSION = '2';

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

// Content is a separate table (not a column on frontmatter) so `SELECT * FROM frontmatter` can't dump file text into context.
function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_size" INTEGER)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, tokenize = 'porter unicode61')`);
  if (getMeta(db, 'schema_version') === null) setMeta(db, 'schema_version', SCHEMA_VERSION);
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

  const seenColumns = getColumns(db);
  const newColumns: string[] = [];
  const parsedDocs: ParsedDoc[] = [];
  const warnings: string[] = [];

  for (const file of toReparse) {
    const { doc, warnings: fileWarnings } = parseFile(file);
    warnings.push(...fileWarnings);
    for (const key of Object.keys(doc.data)) {
      if (!seenColumns.has(key)) {
        seenColumns.add(key);
        newColumns.push(key);
      }
    }
    parsedDocs.push(doc);
  }

  const allColumns = [...seenColumns];
  const insertSql = `INSERT OR REPLACE INTO frontmatter (${allColumns.map(quoteIdent).join(', ')}) VALUES (${allColumns.map(() => '?').join(', ')})`;

  db.exec('BEGIN');
  try {
    for (const col of newColumns) db.exec(`ALTER TABLE frontmatter ADD COLUMN ${quoteIdent(col)}`);
    // FTS5 has no upsert, so delete-before-insert into `content`.
    const delBody = db.prepare(`DELETE FROM content WHERE "path" = ?`);
    if (vanished.length > 0) {
      const del = db.prepare(`DELETE FROM frontmatter WHERE "path" = ?`);
      for (const path of vanished) {
        del.run(path);
        delBody.run(path);
      }
    }
    if (parsedDocs.length > 0) {
      const insert = db.prepare(insertSql);
      const insertBody = db.prepare(`INSERT INTO content (title, summary, text, "path") VALUES (?, ?, ?, ?)`);
      for (const doc of parsedDocs) {
        const values = allColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_size') return doc.size;
          return doc.data[col] ?? null;
        });
        insert.run(...values);
        delBody.run(doc.relPath);
        insertBody.run(doc.search.title, doc.search.summary, doc.search.text, doc.relPath);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { parsed: parsedDocs.length, warnings };
}

export function open(cfg: ResolvedConfig): OpenResult {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  registerFunctions(db);

  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

  // Schema version mismatch: reconcile only reparses changed files, so an old cache can't be patched up incrementally -- rebuild instead.
  const version = getMeta(db, 'schema_version');
  if (version !== null && version !== SCHEMA_VERSION) {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
    return open(cfg);
  }

  ensureSchema(db);
  const { parsed, warnings } = reconcile(db, cfg, cfg.baseDir);

  return { db, cfg, dbPath, parsed, warnings };
}

// Manual reset for a doubted cache.
export function rebuild(cfg: ResolvedConfig): OpenResult {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
  return open(cfg);
}
