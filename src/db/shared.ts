import type { DatabaseSync } from 'node:sqlite';

// SQL and meta-table primitives both open() and reconcile() need, kept below both so
// neither imports the other's module.

export function quoteIdent(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

export function getColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
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
