import type { Store } from './types.ts';

// Portable meta key/value reads for external callers (watch.ts, cli/status.ts) coarse enough
// to cross the async boundary per call; reconcile/open's own hot-path meta access stays
// inside store/shared.ts.

export async function getMeta(store: Store, key: string): Promise<string | null> {
  const stmt = await store.prepare('SELECT value FROM meta WHERE key = ?');
  const row = (await stmt.get(key)) as { value: string } | undefined;
  return row ? row.value : null;
}

export async function setMeta(store: Store, key: string, value: string | null): Promise<void> {
  if (value === null) {
    const stmt = await store.prepare('DELETE FROM meta WHERE key = ?');
    await stmt.run(key);
    return;
  }
  const stmt = await store.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  await stmt.run(key, value);
}
