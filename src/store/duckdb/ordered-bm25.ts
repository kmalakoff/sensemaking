import type { Connection } from '../types.ts';

export const FTS_STEMMER = 'porter';

// Keep deduplication native, but return original tokens so native scoring stems once.
export async function nativeQueryTerms(conn: Connection, query: string): Promise<string[]> {
  const stmt = await conn.prepare(`
    WITH tokens AS (SELECT unnest(fts_main_content.tokenize(?)) AS raw_term)
    SELECT min(raw_term) AS term FROM tokens
    WHERE raw_term <> '' GROUP BY stem(raw_term, '${FTS_STEMMER}') ORDER BY term
  `);
  const rows = (await stmt.all(query)) as Array<{ term: string }>;
  return rows.map(({ term }) => term);
}

// Fixed parameters avoid a correlated document-by-term intermediate relation in DuckDB.
// Only the number of terms shapes this authored SQL; query values are always bound.
export function orderedBm25Sql(field: 'title' | 'summary' | 'text', termCount: number): string {
  if (termCount === 0) return 'NULL';
  const contributions = Array.from({ length: termCount }, () => `SELECT fts_main_content.match_bm25(content."path", ?, fields := '${field}', conjunctive := false) AS score`);
  return `(SELECT sum(score ORDER BY score) FROM (${contributions.join(' UNION ALL ')}))`;
}
