// D1: fts BM25 for ranking, contains() scans for exact substring / phrase verification /
// unspaced scripts, JS excerpts for every doc (no snippet()).
import { SenseError } from '../../errors.ts';
import { UNSPACED_SCRIPTS } from '../../text/segment.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';

const FIELDS = ['title', 'summary', 'text'] as const;
type Field = (typeof FIELDS)[number];
// Mirrors sqlite's bm25(content, 10.0, 5.0, 1.0, ...) column-weight intent; DuckDB's
// match_bm25 has no field_weights argument (verified 1.5.5), so each field is scored
// separately and combined here.
const FIELD_WEIGHT: Record<Field, number> = { title: 10, summary: 5, text: 1 };

const UNSPACED_RUN = new RegExp(`[${UNSPACED_SCRIPTS}]`, 'u');

// FTS5 operator syntax (sqlite.org/fts5.html sec. 3) that words/substrings below would
// otherwise silently treat as literal terms instead of honoring (PRINCIPLES: no-silent-modes).
// Checked against terms with quoted spans blanked -- those go through contains() and are
// supported.
const FTS5_OPERATORS: Array<{ label: string; re: RegExp }> = [
  { label: 'prefix query', re: /[\p{L}\p{N}_]+\*(?=\s|$)/u },
  { label: 'boolean operator', re: /(?:^|\s)(?:AND|OR|NOT)(?=\s|$)/ },
  { label: 'NEAR operator', re: /(?:^|\s)NEAR\b/ },
  { label: 'initial-token operator', re: /(?:^|\s)\^\S+/ },
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

interface FtsIndexState {
  stale: boolean;
}

// A run whose script marks no word boundaries makes match_bm25's whitespace tokenizer index
// the whole run as one token (same gap FTS5 has without the `_seg` sidecar), so such runs --
// and any author-quoted phrase, any script -- go through contains() instead of the fts index.
function splitTerms(terms: string): { words: string[]; substrings: string[] } {
  const words: string[] = [];
  const substrings: string[] = [];
  const withoutPhrases = terms.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const phrase = inner.trim();
    if (phrase.length === 0) return ' ';
    substrings.push(phrase);
    if (!UNSPACED_RUN.test(phrase)) for (const w of phrase.split(/\s+/)) if (w.length > 0) words.push(w);
    return ' ';
  });
  for (const tok of withoutPhrases.split(/\s+/)) {
    if (tok.length === 0) continue;
    if (UNSPACED_RUN.test(tok)) substrings.push(tok);
    else words.push(tok);
  }
  return { words, substrings };
}

// No incremental update (verified 1.5.5: PRAGMA create_fts_index is rebuild-only), so this
// pays the full rebuild -- but only once per store instance's first lexical query, and only
// when content actually changed since (see FtsIndexState / duckdb/store.ts's markStale()).
async function ensureFtsFresh(conn: Connection, state: FtsIndexState): Promise<void> {
  if (!state.stale) return;
  await conn.exec('INSTALL fts; LOAD fts;');
  await withTransaction(conn, async () => {
    // stopwords='none': sqlite's porter/unicode61 tokenizer never removes stopwords either
    // (verified 1.5.5), and the fts extension's default 571-word English list would otherwise
    // silently drop common query words (e.g. "and") from the index but not from match_bm25's
    // conjunctive gate, making a bare multi-word query that contains one match nothing.
    await conn.exec(`PRAGMA create_fts_index('content', 'path', 'title', 'summary', 'text', stopwords='none', overwrite=1)`);
  });
  state.stale = false;
}

// Per-word-term and per-substring-term SQL fragments, field-weighted the same way for both
// (title 10 / summary 5 / text 1), plus the params in the exact left-to-right order they are
// emitted -- positional `?` binding requires that order to match the assembled SQL text. Score
// and gate params are collected apart and joined at the end because the assembled SQL puts
// every score part ahead of every gate part: appending to one array term by term matches that
// text only while the query has words or substrings, never both, and silently shifts each `?`
// by one as soon as it has both (PRINCIPLES: no-silent-modes -- a shifted bind answers a
// different question rather than failing).
function buildScoreAndGate(words: string[], substrings: string[]): { scoreSql: string; gateSql: string; params: unknown[] } {
  const scoreParts: string[] = [];
  const gateParts: string[] = [];
  const scoreParams: unknown[] = [];
  const gateParams: unknown[] = [];

  if (words.length > 0) {
    const wordQuery = words.join(' ');
    for (const field of FIELDS) {
      scoreParts.push(`${FIELD_WEIGHT[field]}.0 * COALESCE(fts_main_content.match_bm25(content."path", ?, fields := '${field}', conjunctive := false), 0)`);
      scoreParams.push(wordQuery);
    }
    gateParts.push(`fts_main_content.match_bm25(content."path", ?, conjunctive := true) IS NOT NULL`);
    gateParams.push(wordQuery);
  }

  for (const raw of substrings) {
    const needle = raw.toLowerCase();
    for (const field of FIELDS) {
      scoreParts.push(`${FIELD_WEIGHT[field]}.0 * CAST(contains(lower(content.${field}), ?) AS INTEGER)`);
      scoreParams.push(needle);
    }
    gateParts.push(`contains(lower(content.title) || ' ' || lower(content.summary) || ' ' || lower(content.text), ?)`);
    gateParams.push(needle);
  }

  return { scoreSql: scoreParts.join(' + '), gateSql: gateParts.join(' AND '), params: [...scoreParams, ...gateParams] };
}

// Ranked word-match query, scoped by the caller-built SQL fragments (same fragments sqlite's
// queryLexical takes). `hit` is always NULL: no snippet() equivalent exists, so every row goes
// through the caller's JS excerpt fallback (commands/search.ts) rather than a second excerpt path.
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions, state: FtsIndexState): Promise<LexicalHit[]> {
  const unsupported = unsupportedOperator(terms);
  if (unsupported !== null) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "duckdb" does not implement FTS5's ${unsupported.label} ("${unsupported.token}") in this build; rephrase "${terms.trim()}" without it, or set "store" to "sqlite" in this tree's config to search it as written`);
  }
  const { whereJoin, whereCond, scopeCond, limit } = opts;
  const { words, substrings } = splitTerms(terms);
  if (words.length === 0 && substrings.length === 0) return [];

  if (words.length > 0) await ensureFtsFresh(conn, state);

  const { scoreSql, gateSql, params } = buildScoreAndGate(words, substrings);
  const sql = `SELECT path, NULL AS hit FROM (
    SELECT content."path" AS path, (${scoreSql}) AS score
    FROM content
    ${whereJoin}
    WHERE ${gateSql}
    ${whereCond} ${scopeCond}
  ) sq ORDER BY score DESC, path LIMIT ?`;
  const stmt = await conn.prepare(sql);
  return (await stmt.all(...params, limit)) as unknown as LexicalHit[];
}

// One instance per store: `stale` starts true (a fresh connection cannot know whether an
// on-disk fts schema still matches `content`), and store.ts's reconcile wrapper flips it back
// to true whenever content changes, so the next query rebuilds before ranking against it.
export function createLexicalIndex(conn: Connection): { query: (terms: string, opts: LexicalQueryOptions) => Promise<LexicalHit[]>; markStale: () => void } {
  const state: FtsIndexState = { stale: true };
  return {
    query: (terms, opts) => queryLexical(conn, terms, opts, state),
    markStale: () => {
      state.stale = true;
    },
  };
}
