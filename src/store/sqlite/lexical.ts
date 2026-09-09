import { segmentMatch } from '../../text/segment.ts';
import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';

const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0, 0, 10.0, 5.0, 1.0)';

// Ranked BM25 word-match query, scoped by the caller-built SQL fragments. An
// unspaced-script run in `terms` becomes a quoted grapheme phrase against the `_seg` sidecars.
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions): Promise<LexicalHit[]> {
  const { whereJoin, whereCond, scopeCond, limit } = opts;
  const query = segmentMatch(terms);
  // A run of pure unspaced-script punctuation segments to nothing searchable: an empty MATCH
  // string is an FTS5 syntax error, not zero rows, so return zero rows directly rather than issuing it.
  if (query.trim() === '') return [];
  const sql = `SELECT content.path AS path FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ${scopeCond} ORDER BY ${WEIGHTED_BM25} LIMIT ${limit}`;
  const stmt = await conn.prepare(sql);
  return (await stmt.all(query)) as unknown as LexicalHit[];
}
