// T1: Tantivy FTS via fts_match/fts_score on the default-tokenizer index for bare words and
// quoted phrases, plus a second ngram-tokenized index over "_ngram" sidecars for unspaced-script runs.
import { SenseError } from '../../errors.ts';
import { hasUnspacedRun } from '../../text/segment.ts';
import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';

const FIELDS = ['title', 'summary', 'text'] as const;
const NGRAM_FIELDS = ['title_ngram', 'summary_ngram', 'text_ngram'] as const;

// FTS5 operator syntax a bare query would otherwise treat as literal text (PRINCIPLES:
// no-silent-modes). `^` is rejected either way: boost to Tantivy, initial-token match to FTS5.
const FTS5_OPERATORS: Array<{ label: string; re: RegExp }> = [
  { label: 'prefix query', re: /[\p{L}\p{N}_]+\*(?=\s|$)/u },
  { label: 'boolean operator', re: /(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/ },
  { label: 'NEAR operator', re: /(?:^|\s)NEAR\b/ },
  { label: 'boost/initial-token operator', re: /\S*\^\S*/ },
  { label: 'column filter', re: /(?:^|\s)[\p{L}_]\w*\s*:/u },
];

function unsupportedOperator(terms: string): { label: string; token: string } | null {
  const withoutPhrases = terms.replace(/"[^"]*"/g, ' ');
  for (const { label, re } of FTS5_OPERATORS) {
    const m = withoutPhrases.match(re);
    if (m) return { label, token: m[0].trim() };
  }
  return null;
}

// A run whose script marks no word boundaries indexes as one opaque token under every tokenizer
// but ngram, so such runs -- bare or quoted -- go to the ngram sidecar index instead.
function splitTerms(terms: string): { words: string[]; phrases: string[]; unspaced: string[] } {
  const words: string[] = [];
  const phrases: string[] = [];
  const unspaced: string[] = [];
  const withoutPhrases = terms.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const phrase = inner.trim();
    if (phrase.length === 0) return ' ';
    if (hasUnspacedRun(phrase)) unspaced.push(phrase);
    else phrases.push(phrase);
    return ' ';
  });
  for (const tok of withoutPhrases.split(/\s+/)) {
    if (tok.length === 0) continue;
    if (hasUnspacedRun(tok)) unspaced.push(tok);
    else words.push(tok);
  }
  return { words, phrases, unspaced };
}

// fts_match/fts_score's query argument must be a SQL literal: bound as `?`, the row set stays
// correct but fts_score silently returns 0 for every row (PRINCIPLES: no-silent-modes).
function escapeFtsLiteral(query: string): string {
  return query.replace(/'/g, "''");
}

// Terms are quoted ("O'Brien's" is a parse error bare) and AND-joined: Tantivy's default for
// bare terms is disjunctive, so space-joining would loosen "apple banana" into "apple OR banana".
function buildQueries(words: string[], phrases: string[], unspaced: string[]): { defaultQuery: string; ngramQuery: string } {
  const defaultParts = [...words, ...phrases].map((t) => `"${t}"`);
  const unspacedParts = unspaced.map((t) => `"${t}"`);
  return { defaultQuery: defaultParts.join(' AND '), ngramQuery: unspacedParts.join(' AND ') };
}

// fts_score() is real only as a SELECT's bare projected expression, and only for the index that
// SELECT's fts_match() chose; every other form silently returns 0. Hence one SELECT per index.
function ftsBranch(cols: readonly string[], query: string, opts: LexicalQueryOptions): string {
  const colList = cols.map((c) => `content.${c}`).join(', ');
  const lit = escapeFtsLiteral(query);
  return `SELECT content."path" AS path, fts_score(${colList}, '${lit}') AS score
    FROM content ${opts.whereJoin} WHERE fts_match(${colList}, '${lit}') ${opts.whereCond} ${opts.scopeCond}`;
}

// Ranked query, scoped by the caller-built SQL fragments (same shape sqlite's/duckdb's
// queryLexical take). `hit` is always NULL: fts_highlight returns the full column text, not a bounded snippet, so every row goes through the caller's JS excerpt fallback (commands/search.ts).
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions): Promise<LexicalHit[]> {
  const unsupported = unsupportedOperator(terms);
  if (unsupported !== null) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "turso" does not implement FTS5's ${unsupported.label} ("${unsupported.token}") in this build; rephrase "${terms.trim()}" without it, or set "store" to "sqlite" in this tree's config to search it as written`);
  }
  const { words, phrases, unspaced } = splitTerms(terms);
  const { defaultQuery, ngramQuery } = buildQueries(words, phrases, unspaced);
  if (defaultQuery === '' && ngramQuery === '') return [];

  const branches: string[] = [];
  if (defaultQuery !== '') branches.push(ftsBranch(FIELDS, defaultQuery, opts));
  if (ngramQuery !== '') branches.push(ftsBranch(NGRAM_FIELDS, ngramQuery, opts));

  // HAVING COUNT(*) = branches.length is the AND across indexes; with one branch it is a no-op,
  // `path` being content's primary key. fts_score is higher-is-better BM25, so DESC.
  const sql = `SELECT path, NULL AS hit FROM (
    SELECT path, SUM(score) AS score FROM (
      ${branches.join(' UNION ALL ')}
    ) parts GROUP BY path HAVING COUNT(*) = ${branches.length}
  ) sq ORDER BY score DESC, path LIMIT ?`;
  const stmt = await conn.prepare(sql);
  const rows = (await stmt.all(opts.limit)) as unknown as LexicalHit[];
  // A concurrent FTS read during an open write transaction can yield a {path: null} row. Raised,
  // not filtered: filtering returns a silently short result (PRINCIPLES: no-silent-modes).
  if (rows.some((r) => r.path === null)) {
    throw new SenseError('LEXICAL_NULL_PATH', 'store "turso" returned a search hit with no path (a known engine anomaly under concurrent FTS reads); retry the query');
  }
  return rows;
}
