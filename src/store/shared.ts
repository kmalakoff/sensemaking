import type { Connection } from './types.ts';

// SQL and meta-table primitives both stores' open()/reconcile() need. Engine-neutral: both
// stores' Connection satisfies the same async exec/prepare/runBatch shape (types.ts).

export function quoteIdent(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

export async function getColumns(conn: Connection): Promise<Set<string>> {
  const stmt = await conn.prepare('PRAGMA table_info(frontmatter)');
  const rows = (await stmt.all()) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

export async function getMeta(conn: Connection, key: string): Promise<string | null> {
  const stmt = await conn.prepare('SELECT value FROM meta WHERE key = ?');
  const row = (await stmt.get(key)) as { value: string } | undefined;
  return row ? row.value : null;
}

export async function setMeta(conn: Connection, key: string, value: string | null): Promise<void> {
  if (value === null) {
    const stmt = await conn.prepare('DELETE FROM meta WHERE key = ?');
    await stmt.run(key);
    return;
  }
  const stmt = await conn.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  await stmt.run(key, value);
}

// Reconcile's own write-transaction duration, for open()'s derived busy_timeout: keep the
// observed max so a big watcher reconcile's lock hold is what the next open bounds its wait against.
export async function recordReconcileDuration(conn: Connection, ms: number): Promise<void> {
  const prevRaw = await getMeta(conn, 'reconcile_max_ms');
  // -1, not 0, so a genuinely 0ms first reconcile (sub-millisecond, common on a tiny tree)
  // still gets recorded instead of losing to the "nothing recorded yet" default.
  const prevMax = prevRaw === null ? -1 : Number(prevRaw);
  if (ms > prevMax) await setMeta(conn, 'reconcile_max_ms', String(ms));
}
