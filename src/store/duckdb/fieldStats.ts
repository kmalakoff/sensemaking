import { quoteIdent } from '../shared.ts';
import type { Connection, FieldStat } from '../types.ts';

// DuckDB's frontmatter columns are VARIANT (reconcile.ts's comment on why), so typeof() reports
// VARIANT for every field regardless of the boxed value; variant_typeof() reports the boxed
// native type instead (spike-verified against mapValue()'s actual bind shapes: a bound JS bigint
// always boxes as INT128, a non-integer JS number always boxes as DOUBLE, a string as VARCHAR --
// literal SQL values box narrower, e.g. INTEGER/DECIMAL(p, s), which this still covers since a
// query issued through `sense sql` can produce either). Mapped onto the shared integer/real/text
// vocabulary sqlite/turso's typeof() already emits natively; an unrecognized name throws rather
// than being silently called text (no-silent-modes).
function classifyVariantType(name: string, field: string): 'integer' | 'real' | 'text' {
  if (/^U?INT\d+$/.test(name)) return 'integer';
  if (name === 'FLOAT' || name === 'DOUBLE' || name.startsWith('DECIMAL(')) return 'real';
  if (name === 'VARCHAR') return 'text';
  throw new Error(`duckdb: variant_typeof() returned unrecognized type "${name}" for column "${field}"`);
}

// One aggregate query, one result row: COUNT + string_agg(DISTINCT variant_typeof()) per
// column, so the query stays O(columns) rather than O(rows x columns). '|' is the string_agg
// separator, not ',': DECIMAL's own display name ("DECIMAL(4, 2)") contains a comma, which a
// ',' separator could not be split back apart from.
export async function fieldStats(conn: Connection, columns: string[], scopeWhere: string): Promise<FieldStat[]> {
  const exprs = columns.map((name, i) => {
    const quoted = quoteIdent(name);
    return `COUNT(${quoted}) AS n${i}, string_agg(DISTINCT variant_typeof(${quoted}), '|') FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
  });
  const stmt = await conn.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter ${scopeWhere}`);
  const row = (await stmt.get()) as Record<string, number | string | null>;
  return columns.map((name, i) => {
    const raw = ((row[`t${i}`] as string) ?? '').split('|').filter(Boolean);
    const types = [...new Set(raw.map((t) => classifyVariantType(t, name)))].sort();
    return { field: name, coverage: Number(row[`n${i}`] ?? 0), type: types.join(',') };
  });
}
