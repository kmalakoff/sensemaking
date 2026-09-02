import { quoteIdent } from '../shared.ts';
import type { Connection, FieldStat } from '../types.ts';

// DuckDB's frontmatter columns are VARIANT (reconcile.ts), so typeof() always reports VARIANT; variant_typeof() reports the boxed native
// type instead -- INT128, DOUBLE, VARCHAR, or a literal's narrower type like DECIMAL(p, s) -- mapped onto sqlite/turso's integer/real/text vocabulary; an unrecognized name throws (no-silent-modes).
function classifyVariantType(name: string, field: string): 'integer' | 'real' | 'text' {
  if (/^U?INT\d+$/.test(name)) return 'integer';
  if (name === 'FLOAT' || name === 'DOUBLE' || name.startsWith('DECIMAL(')) return 'real';
  if (name === 'VARCHAR') return 'text';
  throw new Error(`duckdb: variant_typeof() returned unrecognized type "${name}" for column "${field}"`);
}

// duckdb degrades superlinearly in the number of string_agg(DISTINCT variant_typeof()) aggregates in
// one projection: 301 columns cost 1148ms in one query against 10ms for COUNT alone over the same
// columns, so it is the aggregate count, not the width. Measured chunk sizes at 301 columns:
// 10 -> 71ms, 16 -> 81ms, 25 -> 88ms, 40 -> 110ms, 64 -> 158ms, flat between 10 and 25. Chunking
// also wins on an ordinary tree (31 columns: 17ms in one query, 11ms chunked), so there is no
// small-tree cost to trade against. sqlite and turso need none of this: GROUP_CONCAT over 300
// columns runs in 7ms.
const AGGREGATES_PER_QUERY = 16;

// COUNT + string_agg(DISTINCT variant_typeof()) per column keeps this O(columns), not O(rows x columns).
// '|' is the separator, not ',': DECIMAL's display name ("DECIMAL(4, 2)") contains a comma.
export async function fieldStats(conn: Connection, columns: string[], scopeWhere: string): Promise<FieldStat[]> {
  const stats: FieldStat[] = [];
  for (let start = 0; start < columns.length; start += AGGREGATES_PER_QUERY) {
    const chunk = columns.slice(start, start + AGGREGATES_PER_QUERY);
    const exprs = chunk.map((name, i) => {
      const quoted = quoteIdent(name);
      return `COUNT(${quoted}) AS n${i}, string_agg(DISTINCT variant_typeof(${quoted}), '|') FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
    });
    const stmt = await conn.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter ${scopeWhere}`);
    const row = (await stmt.get()) as Record<string, number | string | null>;
    for (const [i, name] of chunk.entries()) {
      const raw = ((row[`t${i}`] as string) ?? '').split('|').filter(Boolean);
      const types = [...new Set(raw.map((t) => classifyVariantType(t, name)))].sort();
      stats.push({ field: name, coverage: Number(row[`n${i}`] ?? 0), type: types.join(',') });
    }
  }
  return stats;
}
