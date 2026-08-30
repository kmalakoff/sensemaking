import { quoteIdent } from '../shared.ts';
import type { Connection, FieldStat } from '../types.ts';

// One aggregate query, one result row: COUNT + GROUP_CONCAT(DISTINCT typeof()) per column, so
// the query stays O(columns) rather than O(rows x columns). typeof()'s output already is the
// shared vocabulary (integer/real/text -- mapValue() never binds a boolean or blob), so no
// mapping step is needed here (contrast duckdb/fieldStats.ts). GROUP_CONCAT(DISTINCT ...)'s
// order is not guaranteed sorted (spike-verified: 3+ distinct types come back in insertion
// order), so the type set is sorted in JS.
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
