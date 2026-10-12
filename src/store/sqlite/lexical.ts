import { segmentMatch } from '../../text/segment.ts';
import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';
import { sqliteFts } from './engine.ts';

// Ranked BM25 word-match query, scoped by the caller-built SQL fragments. An
// unspaced-script run in `terms` becomes a quoted grapheme phrase against the `_seg` sidecars.
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions): Promise<LexicalHit[]> {
  const { whereJoin, whereCond, scopeCond, limit } = opts;
  const query = segmentMatch(terms);
  // A run of pure unspaced-script punctuation segments to nothing searchable: an empty MATCH
  // string is an FTS5 syntax error, not zero rows, so return zero rows directly rather than issuing it.
  if (query.trim() === '') return [];
  const stmt = await conn.prepare(sqliteFts().rankedMatch(whereJoin, whereCond, scopeCond, limit));
  return (await stmt.all(query)) as unknown as LexicalHit[];
}
