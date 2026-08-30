import { quoteIdent } from '../shared.ts';
import type { Connection, FieldStat } from '../types.ts';

// One aggregate query per column (COUNT + GROUP_CONCAT(DISTINCT typeof())), O(columns) not O(rows x columns);
// typeof()'s output is already the shared vocabulary, and GROUP_CONCAT's order is unsorted, so JS sorts the type set.
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
