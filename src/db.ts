import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Config, ResolvedConfig } from './config.ts';
import { STATE_DIR } from './config.ts';
import type { ParsedDoc } from './scan.ts';
import { listFiles, parseFile } from './scan.ts';

// Rows -> SQLite only: schema/ALTER, the reconcile diff + transaction,
// pragmas, the meta table, has() registration. Filesystem reading and
// frontmatter parsing live in scan.ts; this module never touches
// node:fs/gray-matter directly and never prints (throws are for callers).

export const DB_FILENAME = 'cache.db';
export const SCHEMA_VERSION = '1';

export interface OpenResult {
  db: DatabaseSync;
  cfg: ResolvedConfig;
  dbPath: string;
  // Number of files (re)parsed by this open's reconcile -- 0 on a fully
  // warm cache. Tests use this as reconcile instrumentation.
  parsed: number;
  warnings: string[];
}

// Quote a SQL identifier, escaping embedded double quotes so an unusual
// frontmatter key (however unlikely) can't break out of the identifier.
function quoteIdent(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

// The one custom SQL function in the whole tool: has(field, value).
//   - JSON-array field (stored as JSON text, e.g. `["a","b"]`) -> membership
//   - string field -> substring
//   - NULL -> false
function registerFunctions(db: DatabaseSync): void {
  db.function('has', { deterministic: true, varargs: false }, (field: unknown, value: unknown): number => {
    if (field === null || field === undefined) return 0;

    const needle = String(value);

    if (typeof field === 'string') {
      // Try JSON array first (arrays are stored as JSON text).
      if (field.startsWith('[')) {
        try {
          const parsed = JSON.parse(field);
          if (Array.isArray(parsed)) {
            return parsed.some((item) => String(item) === needle) ? 1 : 0;
          }
        } catch {
          // fall through to substring match
        }
      }
      return field.includes(needle) ? 1 : 0;
    }

    // Numbers, etc: coerce to string and substring-match.
    return String(field).includes(needle) ? 1 : 0;
  });
}

function getColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(docs)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS docs ("path" TEXT PRIMARY KEY, "_mtime" REAL, "_size" INTEGER)`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
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
  const row = db.prepare('SELECT COUNT(*) AS n FROM docs').get() as { n: number };
  return row.n;
}

// Reconcile the `docs` table against the filesystem: glob current files via
// scan.ts, reparse stale (mtime/size changed) + new files in one
// transaction, DELETE vanished paths, ALTER TABLE ADD COLUMN for newly
// discovered frontmatter keys. Returns the number of files (re)parsed and
// any warnings scan.ts collected (e.g. reserved-key collisions).
export function reconcile(db: DatabaseSync, cfg: Config, baseDir: string): { parsed: number; warnings: string[] } {
  const files = listFiles(cfg, baseDir);
  const currentSet = new Set(files.map((f) => f.relPath));

  const existingRows = db.prepare(`SELECT "path", "_mtime", "_size" FROM docs`).all() as Array<{
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

  // seenColumns already contains the reserved columns (they're real columns
  // of `docs`), so spreading it alone avoids duplicate names in the INSERT.
  const allColumns = [...seenColumns];
  const insertSql = `INSERT OR REPLACE INTO docs (${allColumns.map(quoteIdent).join(', ')}) VALUES (${allColumns.map(() => '?').join(', ')})`;

  db.exec('BEGIN');
  try {
    for (const col of newColumns) db.exec(`ALTER TABLE docs ADD COLUMN ${quoteIdent(col)}`);
    if (vanished.length > 0) {
      const del = db.prepare(`DELETE FROM docs WHERE "path" = ?`);
      for (const path of vanished) del.run(path);
    }
    if (parsedDocs.length > 0) {
      const insert = db.prepare(insertSql);
      for (const doc of parsedDocs) {
        const values = allColumns.map((col) => {
          if (col === 'path') return doc.relPath;
          if (col === '_mtime') return doc.mtimeMs;
          if (col === '_size') return doc.size;
          return doc.data[col] ?? null;
        });
        insert.run(...values);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { parsed: parsedDocs.length, warnings };
}

// open(resolved config): open (or create) the on-disk SQLite cache at
// `<baseDir>/.sense/cache.db`, reconcile against the filesystem, and return
// a live handle. The DB is a warm start, never a source of truth -- the
// `.md` files remain truth. Takes only an already-resolved config; discovery
// and version-gating are config.ts's job, not this one's.
export function open(cfg: ResolvedConfig): OpenResult {
  const stateDir = join(cfg.baseDir, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, DB_FILENAME);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  registerFunctions(db);

  ensureSchema(db);
  const { parsed, warnings } = reconcile(db, cfg, cfg.baseDir);

  return { db, cfg, dbPath, parsed, warnings };
}

// Delete the `.sense/` state dir entirely and reconcile fresh -- the manual
// reset for lingering columns or a doubted cache.
export function rebuild(cfg: ResolvedConfig): OpenResult {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
  return open(cfg);
}
