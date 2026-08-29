import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';

// snippet() re-tokenizes each candidate doc, superlinearly: ~10s for one 1MB doc
// (benchmark/reports/2026-08-23-hub-release-battery.md). Past this bound, hit stays NULL for
// the caller's JS excerpt fallback.
const SNIPPET_BOUND = 16_384;
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0, 0, 10.0, 5.0, 1.0)';

// Ranked BM25 word-match query with excerpt, scoped by the caller-built SQL fragments.
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions): Promise<LexicalHit[]> {
  const { whereJoin, whereCond, scopeCond, limit } = opts;
  const sql = `SELECT content.path AS path, CASE WHEN length(content.text) <= ${SNIPPET_BOUND} THEN snippet(content, 2, '«', '»', '…', 10) ELSE NULL END AS hit FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ${scopeCond} ORDER BY ${WEIGHTED_BM25} LIMIT ${limit}`;
  const stmt = await conn.prepare(sql);
  return (await stmt.all(terms)) as unknown as LexicalHit[];
}
