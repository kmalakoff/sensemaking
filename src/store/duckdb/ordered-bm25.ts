import type { Connection } from '../types.ts';
import type { DuckdbFtsBuilders } from './engine.ts';

// Keep deduplication native, but return original tokens so native scoring stems once.
export async function nativeQueryTerms(conn: Connection, fts: DuckdbFtsBuilders, query: string): Promise<string[]> {
  const stmt = await conn.prepare(fts.queryTerms());
  const rows = (await stmt.all(query)) as Array<{ term: string }>;
  return rows.map(({ term }) => term);
}

// Fixed parameters avoid a correlated document-by-term intermediate relation in DuckDB.
// Only the number of terms shapes this authored SQL; query values are always bound.
export function orderedBm25Sql(fts: DuckdbFtsBuilders, field: 'title' | 'summary' | 'text', termCount: number): string {
  if (termCount === 0) return 'NULL';
  const contributions = Array.from({ length: termCount }, () => fts.termScore(field));
  return `(SELECT sum(score ORDER BY score) FROM (${contributions.join(' UNION ALL ')}))`;
}
