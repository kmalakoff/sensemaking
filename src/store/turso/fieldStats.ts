import { quoteIdent } from '../shared.ts';
import type { Connection, FieldStat } from '../types.ts';

// Fork of sqlite/fieldStats.ts (house precedent: each store owns its engine-specific SQL, see
// turso/reconcile.ts). Turso is SQLite dialect (spike-verified: typeof(), GROUP_CONCAT, and
// FILTER (WHERE ...) all behave identically to node:sqlite for the bigint/number/string/null
// shapes mapValue() produces), so the SQL text is identical to sqlite's -- only the Connection
// it runs against differs.
export async function fieldStats(conn: Connection, columns: string[], scopeWhere: string): Promise<FieldStat[]> {
  const exprs = columns.map((name, i) => {
    const quoted = quoteIdent(name);
    return `COUNT(${quoted}) AS n${i}, GROUP_CONCAT(DISTINCT typeof(${quoted})) FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
  });
  const stmt = await conn.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter ${scopeWhere}`);
  const row = (await stmt.get()) as Record<string, number | string | null>;
  return columns.map((name, i) => ({
    field: name,
    coverage: Number(row[`n${i}`] ?? 0),
    type: [...new Set(((row[`t${i}`] as string) ?? '').split(',').filter(Boolean))].sort().join(','),
  }));
}
