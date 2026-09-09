// D1: fts BM25 for ranking, contains() scans for exact substring / phrase verification /
// unspaced scripts, JS snippets for every doc (no snippet()).
import { SenseError } from '../../errors.ts';
import { foldForSearch, matchesSearchPhrase, type SearchToken, searchTokens } from '../../text/segment.ts';
import { getMeta, setMeta } from '../shared.ts';
import { withTransaction } from '../transaction.ts';
import type { Connection, LexicalHit, LexicalQueryOptions } from '../types.ts';

const FIELDS = ['title', 'summary', 'text'] as const;
type Field = (typeof FIELDS)[number];
// Mirrors sqlite's bm25(content, 10.0, 5.0, 1.0, ...) column-weight intent; DuckDB's match_bm25 has no
// field_weights argument (verified 1.5.5), so each field is scored separately and combined here.
const FIELD_WEIGHT: Record<Field, number> = { title: 10, summary: 5, text: 1 };

// FTS5 operator syntax (sqlite.org/fts5.html sec. 3) that words/substrings below would otherwise silently
// treat as literal terms (PRINCIPLES: no-silent-modes). Checked with quoted spans blanked; those go through contains() and are supported.
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

// Durable across connections/processes (meta table, shared.ts); `stale` is the in-memory cache of
// it for this connection's lifetime, so a watcher's repeat queries don't re-read meta every time.
const FTS_STALE_META_KEY = 'fts_stale';

// One state per connection, not per store instance: reconcileContent (reconcile.ts) marks it
// stale from outside createLexicalIndex's closure, whether a one-shot open or a watcher's builder ran it.
const ftsState = new WeakMap<Connection, FtsIndexState>();
async function stateFor(conn: Connection): Promise<FtsIndexState> {
  let state = ftsState.get(conn);
  if (!state) {
    // Anything but a persisted '0' (missing key, or '1') means a rebuild is owed: a cache that
    // never built an index, or one a prior process marked stale and never got to clear.
    state = { stale: (await getMeta(conn, FTS_STALE_META_KEY)) !== '0' };
    ftsState.set(conn, state);
  }
  return state;
}

// Called whenever this store's reconcileContent changes `content`; must run inside that same
// transaction (reconcile.ts) so a crash never lands the content write without the stale mark.
export async function markContentStale(conn: Connection): Promise<void> {
  ftsState.set(conn, { stale: true });
  await setMeta(conn, FTS_STALE_META_KEY, '1');
}

// A run whose script marks no word boundaries makes match_bm25's whitespace tokenizer index the whole run as one token,
// so unspaced terms use contains() and quoted phrases use the shared authored-field verifier.
function splitTerms(terms: string): { words: string[]; bareWords: string[]; phraseWords: string[]; substrings: string[]; phrases: SearchToken[][]; emptyPhrase: boolean } {
  const words: string[] = [];
  const bareWords: string[] = [];
  const phraseWords: string[] = [];
  const substrings: string[] = [];
  const phrases: SearchToken[][] = [];
  let emptyPhrase = false;
  const withoutPhrases = terms.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const phrase = inner.trim();
    const phraseTokens = searchTokens(phrase);
    if (phraseTokens.length === 0) {
      emptyPhrase = true;
      return ' ';
    }
    phrases.push(phraseTokens);
    for (const token of phraseTokens) {
      if (token.unspaced) substrings.push(token.text);
      else {
        words.push(token.text);
        phraseWords.push(token.text);
      }
    }
    return ' ';
  });
  for (const tok of withoutPhrases.split(/\s+/)) {
    if (tok.length === 0) continue;
    for (const token of searchTokens(tok)) {
      if (token.unspaced) substrings.push(token.text);
      else {
        words.push(token.text);
        bareWords.push(token.text);
      }
    }
  }
  return { words, bareWords, phraseWords, substrings, phrases, emptyPhrase };
}

// No incremental update (verified 1.5.5: PRAGMA create_fts_index is rebuild-only), so this pays
// the full rebuild whenever `state.stale`, which meta.fts_stale keeps true across processes until cleared below.
async function ensureFtsFresh(conn: Connection, state: FtsIndexState): Promise<void> {
  if (!state.stale) return;
  await conn.exec('INSTALL fts; LOAD fts;');
  await withTransaction(conn, async () => {
    // stopwords='none': sqlite's porter/unicode61 tokenizer never removes stopwords either (verified 1.5.5); the fts extension's
    // default 571-word list would otherwise drop common words (e.g. "and") from the index but not match_bm25's conjunctive gate, breaking multi-word matches.
    await conn.exec(`PRAGMA create_fts_index('content', 'path', 'title', 'summary', 'text', stopwords='none', overwrite=1)`);
    // Same transaction as the rebuild: a crash before commit leaves the mark set (a redundant
    // rebuild next time), never a cleared mark serving a half-built index as fresh.
    await setMeta(conn, FTS_STALE_META_KEY, '0');
  });
  state.stale = false;
}

// Field-weighted fragments (title 10 / summary 5 / text 1), with params emitted in the exact left-to-right order the assembled SQL needs for positional `?` binding.
// score/gate params stay in separate arrays until joined at the end, since the SQL puts every score part before every gate part; sharing one array would shift binds once a query has both words and substrings (PRINCIPLES: no-silent-modes).
function buildScoreAndGate(words: string[], bareWords: string[], phraseWords: string[], substrings: string[]): { scoreSql: string; gateSql: string; params: unknown[] } {
  const scoreParts: string[] = [];
  const gateParts: string[] = [];
  const scoreParams: unknown[] = [];
  const gateParams: unknown[] = [];

  if (words.length > 0) {
    const wordQuery = words.map(foldForSearch).join(' ');
    for (const field of FIELDS) {
      scoreParts.push(`${FIELD_WEIGHT[field]}.0 * COALESCE(fts_main_content.match_bm25(content."path", ?, fields := '${field}', conjunctive := false), 0)`);
      scoreParams.push(wordQuery);
    }
    if (bareWords.length > 0) {
      const nativeGate = `fts_main_content.match_bm25(content."path", ?, conjunctive := true) IS NOT NULL`;
      gateParts.push(nativeGate);
      gateParams.push(bareWords.map(foldForSearch).join(' '));
    }
    if (phraseWords.length > 0) {
      const nativeGate = `fts_main_content.match_bm25(content."path", ?, conjunctive := true) IS NOT NULL`;
      const fallback = phraseWords.map((_word) => `(${FIELDS.map((field) => `contains(strip_accents(lower(content.${field})), ?)`).join(' OR ')})`).join(' AND ');
      gateParts.push(`(${nativeGate} OR (${fallback}))`);
      gateParams.push(phraseWords.map(foldForSearch).join(' '));
      gateParams.push(...phraseWords.flatMap((word) => FIELDS.map(() => foldForSearch(word))));
    }
  }

  for (const raw of substrings) {
    const needle = raw.toLowerCase();
    for (const field of FIELDS) {
      scoreParts.push(`${FIELD_WEIGHT[field]}.0 * CAST(contains(strip_accents(lower(content.${field})), ?) AS INTEGER)`);
      scoreParams.push(foldForSearch(needle));
    }
    gateParts.push(`(${FIELDS.map((field) => `contains(strip_accents(lower(content.${field})), ?)`).join(' OR ')})`);
    gateParams.push(...FIELDS.map(() => foldForSearch(needle)));
  }

  return { scoreSql: scoreParts.join(' + '), gateSql: gateParts.join(' AND ') || 'TRUE', params: [...scoreParams, ...gateParams] };
}

// Ranked query, scoped by the caller-built SQL fragments (same fragments sqlite's queryLexical takes).
// Phrase rows carry authored fields through the post-filter; the public result still contains paths only.
export async function queryLexical(conn: Connection, terms: string, opts: LexicalQueryOptions, state: FtsIndexState): Promise<LexicalHit[]> {
  const unsupported = unsupportedOperator(terms);
  if (unsupported !== null) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "duckdb" does not implement FTS5's ${unsupported.label} ("${unsupported.token}") in this build; rephrase "${terms.trim()}" without it, or set "store" to "sqlite" in this tree's config to search it as written`);
  }
  const { whereJoin, whereCond, scopeCond, limit } = opts;
  const { words, bareWords, phraseWords, substrings, phrases, emptyPhrase } = splitTerms(terms);
  if (emptyPhrase || (words.length === 0 && substrings.length === 0)) return [];

  if (words.length > 0) await ensureFtsFresh(conn, state);

  const { scoreSql, gateSql, params } = buildScoreAndGate(words, bareWords, phraseWords, substrings);
  const selectFields = phrases.length > 0 ? ', content.title, content.summary, content.text' : '';
  const sqlLimit = phrases.length > 0 ? '' : ' LIMIT ?';
  const sql = `SELECT path, score${phrases.length > 0 ? ', title, summary, text' : ''} FROM (
    SELECT content."path" AS path, (${scoreSql}) AS score${selectFields}
    FROM content
    ${whereJoin}
    WHERE ${gateSql}
    ${whereCond} ${scopeCond}
    ) sq ORDER BY score DESC, path${sqlLimit}`;
  const stmt = await conn.prepare(sql);
  const rows = (await stmt.all(...params, ...(phrases.length > 0 ? [] : [limit]))) as Array<LexicalHit & Partial<Record<Field, string>>>;
  const matches = phrases.length === 0 ? rows : rows.filter((row) => phrases.every((phrase) => FIELDS.some((field) => matchesSearchPhrase(row[field] ?? '', phrase))));
  return matches.slice(0, limit).map(({ path }) => ({ path }));
}

// `stale`'s first read for a connection comes from meta.fts_stale (a fresh connection can't know
// otherwise), and reconcileContent (reconcile.ts) marks it stale again on every content change.
export function createLexicalIndex(conn: Connection): { query: (terms: string, opts: LexicalQueryOptions) => Promise<LexicalHit[]>; markStale: () => Promise<void> } {
  return {
    query: async (terms, opts) => queryLexical(conn, terms, opts, await stateFor(conn)),
    markStale: () => markContentStale(conn),
  };
}
