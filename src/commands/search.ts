import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stemmer } from 'stemmer';
import type { ResolvedConfig } from '../config/index.ts';
import { embedConfig, featureEnabled, resolveSearch } from '../config/index.ts';
import { localModelMissing, MODEL_FILENAMES } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import type { Row } from '../output/output.ts';
import { bareTermSyntaxError, searchError } from '../output/search-error.ts';
import type { LexicalHit, Store } from '../store/types.ts';
import { foldForSearch, hasUnspacedRun, searchTokens, unspacedRuns } from '../text/segment.ts';
import { materializeScope, narrowByWhere, rawScope, scopeHasEmbeddings } from './scope.ts';
import { linksCandidates, vectorsCandidates, wordsCandidates } from './signals.ts';

// Default budget behind --snippet-char-limit/--snippet-count-limit: the limit is whatever the
// caller passes, these only say what happens when they pass nothing (DESIGN.md "Search snippets").
export const SNIPPET_CHAR_LIMIT_DEFAULT = 80;
export const SNIPPET_COUNT_LIMIT_DEFAULT = 1;

// Bare terms from an FTS5 query string: strips operators/quoting, not real terms, so the
// snippet scan matches what the query matched -- FTS5 operators are uppercase-only, so this is too.
function extractBareTerms(query: string): string[] {
  const cleaned = query
    .replace(/"/g, ' ')
    .replace(/[()*]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b(\/\d+)?/g, ' ');
  return cleaned
    .split(/\s+/)
    .map((tok) => tok.replace(/^[A-Za-z_]\w*:/, '')) // column filter, e.g. title:term
    .flatMap((tok) => searchTokens(tok).map(({ text }) => text))
    .map((tok) => tok.toLowerCase().trim())
    .filter((tok) => tok.length > 0);
}

// House convention (src/chunk/group.ts): Intl.Segmenter word boundaries, not a bare \b, which
// is ASCII-only. Built on first use: construction is a few ms, paid only when a term matches.
let wordSegmenter: Intl.Segmenter | undefined;

function findOccurrences(text: string, terms: string[]): Array<{ start: number; end: number; term: string }> {
  const occ: Array<{ start: number; end: number; term: string }> = [];
  const textLower = text.toLowerCase();

  // Unspaced scripts (UNSPACED_SCRIPTS) mark no word boundaries: the sense-setup skill promises
  // substring semantics there, so a matching term is found wherever it occurs in the run.
  const unspacedTerms = terms.filter(hasUnspacedRun);
  if (unspacedTerms.length > 0) {
    for (const run of unspacedRuns(text)) {
      const runLower = textLower.slice(run.start, run.end);
      for (const term of unspacedTerms) {
        let idx = 0;
        for (;;) {
          const found = runLower.indexOf(term, idx);
          if (found === -1) break;
          occ.push({ start: run.start + found, end: run.start + found + term.length, term });
          idx = found + term.length;
        }
      }
    }
  }

  // Spaced scripts: a word is marked when its porter stem equals a query term's stem, the same
  // algorithm both indexes tokenize with (sqlite's TOKENIZE = 'porter unicode61'; duckdb's fts default).
  const spacedTerms = terms.filter((t) => !hasUnspacedRun(t));
  if (spacedTerms.length > 0) {
    const termByStem = new Map(spacedTerms.map((t) => [stemmer(foldForSearch(t)), t]));
    const stemInitials = new Set(Array.from(termByStem.keys(), (term) => term[0]));
    for (const match of searchTokens(text)) {
      const segment = match.text;
      if (match.unspaced) continue;
      const folded = foldForSearch(segment);
      // Porter stemming changes suffixes only, so a different initial cannot match a query stem.
      if (!stemInitials.has(folded[0])) continue;
      const term = termByStem.get(stemmer(folded));
      if (term !== undefined) occ.push({ start: match.start, end: match.end, term });
    }
  }

  return occ.sort((a, b) => a.start - b.start || b.end - a.end);
}

// Segment boundaries of the whole text, word granularity: the only cut points a snippet edge
// may land on. One rule for every script (DESIGN.md "Cutting") -- a regex \b is ASCII-only and
// would mis-cut Japanese, Chinese and Thai, which Intl.Segmenter divides by dictionary instead.
function wordBoundaries(text: string): number[] {
  wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' });
  const bounds = [0];
  for (const { index, segment } of wordSegmenter.segment(text)) bounds.push(index + segment.length);
  return bounds;
}

// bounds is sorted: snaps are binary searches, since each runs once per candidate window.
function snapForward(bounds: number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return bounds[lo];
}

function snapBackward(bounds: number[], pos: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  let result = bounds[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid] <= pos) {
      lo = mid;
      result = bounds[mid];
    } else hi = mid - 1;
  }
  return result;
}

function firstBoundAfter(bounds: number[], pos: number): number | undefined {
  let lo = 0;
  let hi = bounds.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bounds[mid] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return bounds[lo];
}

// A raw, unmarked upper bound: [start, end) inside [anchor, anchor+charLimit), edges on
// boundaries. Markup (guillemets, ellipses) added on top of this can push the rendered result
// past charLimit, which is what fitEnd() below corrects for; this is only the starting guess.
// A single segment spanning the whole target window (a word longer than the char limit) is the
// one case where holding the boundary rule means the budget is not a hard ceiling.
function cutWindow(text: string, bounds: number[], anchor: number, charLimit: number): { start: number; end: number } {
  const rawEnd = Math.min(text.length, anchor + charLimit);
  const start = snapForward(bounds, anchor);
  let end = snapBackward(bounds, rawEnd);
  if (end <= start) end = firstBoundAfter(bounds, start) ?? text.length;
  return { start, end: Math.min(end, text.length) };
}

// The largest boundary <= upperBound, > floor, whose rendered [*, end) fits charLimit. Markup
// only ever adds characters as end grows, so rendered length is non-decreasing in end and
// shrinking from upperBound is guaranteed to find the true fit rather than guess at it.
// `floor` is the one end this never shrinks past (the anchor's own marked word, or the first
// word in the unmarked fallback): DESIGN.md's budget is a ceiling except here, where returning
// nothing is worse than a single word that overruns it.
function fitEnd(render: (end: number) => string, bounds: number[], floor: number, upperBound: number, charLimit: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bounds[mid] <= upperBound) lo = mid;
    else hi = mid - 1;
  }
  for (; lo >= 0 && bounds[lo] > floor; lo--) {
    if (render(bounds[lo]).length <= charLimit) return bounds[lo];
  }
  return floor;
}

interface Span {
  start: number;
  end: number;
}

interface SnippetWindow extends Span {
  distinct: number;
  count: number;
}

// occ is start-sorted: a window's first candidate occurrence is a binary search, not a walk.
function firstOccAtOrAfter(occ: Array<{ start: number; end: number; term: string }>, pos: number): number {
  let lo = 0;
  let hi = occ.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (occ[mid].start < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function renderWindow(text: string, occ: Array<{ start: number; end: number; term: string }>, win: Span): string {
  let out = '';
  let cursor = win.start;
  for (let i = firstOccAtOrAfter(occ, win.start); i < occ.length && occ[i].start < win.end; i++) {
    const o = occ[i];
    if (o.end > win.end) continue;
    // Occurrences of duplicate or substring-overlapping terms ("test tests") can overlap;
    // emitting each would duplicate document text. Keep the first, absorb the rest.
    if (o.start < cursor) continue;
    out += `${text.slice(cursor, o.start)}«${text.slice(o.start, o.end)}»`;
    cursor = o.end;
  }
  out += text.slice(cursor, win.end);
  const prefix = win.start > 0 ? '…' : '';
  const suffix = win.end < text.length ? '…' : '';
  return `${prefix}${out.replace(/\s+/g, ' ')}${suffix}`;
}

// Scores every occurrence-anchored candidate window: most distinct terms wins, ties broken by
// most total hits -- coverage now that occurrences are real words, not the false-fragment counts
// a substring scan produced. Selection itself is unevaluated (DESIGN.md "Selection, unsettled").
// The window's `end` is fitted to the *rendered* text, markup included, not the raw span: a
// window dense with marks (every guillemet pair adds two characters) shrinks to fit the same
// budget a sparse one fills almost exactly.
function scoreWindows(occ: Array<{ start: number; end: number; term: string }>, bounds: number[], text: string, charLimit: number): SnippetWindow[] {
  const candidates: SnippetWindow[] = [];
  for (let i = 0; i < occ.length; i++) {
    const winEnd = occ[i].start + charLimit;
    const seen = new Set<string>();
    let count = 0;
    for (let j = i; j < occ.length && occ[j].start < winEnd; j++) {
      seen.add(occ[j].term);
      count++;
    }
    const start = snapForward(bounds, occ[i].start);
    const floor = Math.max(start, occ[i].end);
    const upperBound = Math.max(floor, cutWindow(text, bounds, occ[i].start, charLimit).end);
    const end = fitEnd((e) => renderWindow(text, occ, { start, end: e }), bounds, floor, upperBound, charLimit);
    candidates.push({ start, end, distinct: seen.size, count });
  }
  return candidates;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

// Same scoring function as a single snippet, kept rather than discarded (DESIGN.md "Several
// snippets per note"): rank by score, take the top non-overlapping windows, then reorder to the
// note's own order, since several passages from one note read as an abridged note.
function selectWindows(candidates: SnippetWindow[], countLimit: number): { chosen: SnippetWindow[]; best: SnippetWindow } {
  const ranked = candidates.slice().sort((a, b) => b.distinct - a.distinct || b.count - a.count);
  const chosen: SnippetWindow[] = [];
  for (const c of ranked) {
    if (chosen.length >= countLimit) break;
    if (chosen.some((s) => overlaps(s, c))) continue;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.start - b.start);
  return { chosen, best: ranked[0] };
}

// Builds bounded marked passages and returns the best window's offset for section lookup.
export function computeSnippets(text: string, terms: string[], charLimit: number, countLimit: number): { snippets: string[]; offset: number } {
  const occ = findOccurrences(text, terms);
  const bounds = wordBoundaries(text);
  if (occ.length === 0) {
    // A term matched only via title/summary, not this body text, finds no occurrence here;
    // fall back to the doc's start, unmarked.
    const render = (end: number): string => `${text.slice(0, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
    const floor = bounds.find((b) => b > 0) ?? text.length;
    const upperBound = Math.max(floor, cutWindow(text, bounds, 0, charLimit).end);
    const end = fitEnd(render, bounds, floor, upperBound, charLimit);
    return { snippets: [render(end)], offset: 0 };
  }
  const candidates = scoreWindows(occ, bounds, text, charLimit);
  const { chosen, best } = selectWindows(candidates, countLimit);
  return { snippets: chosen.map((win) => renderWindow(text, occ, win)), offset: best.start };
}

// Converts an offset in the original text to its one-based line number.
export function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

async function lineRangeFor(store: Store, path: string, line: number): Promise<string | null> {
  const stmt = await store.prepare('SELECT start_line, end_line FROM sections WHERE "path" = ? AND start_line <= ? AND end_line >= ? ORDER BY start_line DESC LIMIT 1');
  const row = (await stmt.get(path, line, line)) as { start_line: number; end_line: number } | undefined;
  return row ? `L${row.start_line}-${row.end_line}` : null;
}

export interface SearchOptions {
  k?: number;
  where?: string; // SQL fragment against frontmatter alias `f`, e.g. "f.status = 'active'"
  preset?: string; // named preset; unknown name throws listing declared presets, undefined -> "default"
  include?: string[]; // ad hoc scope override (repeatable --include); independent of exclude
  exclude?: string[]; // ad hoc scope override (repeatable --exclude); independent of include
  noExclude?: boolean; // --no-exclude: drop the preset's exclude for this command
  snippetCharLimit?: number; // --snippet-char-limit; defaults to SNIPPET_CHAR_LIMIT_DEFAULT
  snippetCountLimit?: number; // --snippet-count-limit; defaults to SNIPPET_COUNT_LIMIT_DEFAULT
}

function validateSearchOptions(opts: SearchOptions): void {
  for (const [name, value] of [
    ['k', opts.k],
    ['snippetCharLimit', opts.snippetCharLimit],
    ['snippetCountLimit', opts.snippetCountLimit],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0)) {
      throw new SenseError('SEARCH_OPTION_INVALID', `search option "${name}" must be a positive finite integer, got ${String(value)}`);
    }
  }
}

// Hydrates already-ranked rows with snippets and containing-section ranges without reranking.
export async function hydrateSearchRows(store: Store, cfg: ResolvedConfig, rows: Row[], matchedPaths: Set<string>, terms: string, opts: Pick<SearchOptions, 'snippetCharLimit' | 'snippetCountLimit'> = {}): Promise<void> {
  if (matchedPaths.size === 0) return;
  const bareTerms = extractBareTerms(terms);
  const charLimit = opts.snippetCharLimit ?? SNIPPET_CHAR_LIMIT_DEFAULT;
  const countLimit = opts.snippetCountLimit ?? SNIPPET_COUNT_LIMIT_DEFAULT;
  for (const row of rows) {
    if (!matchedPaths.has(row.path as string)) continue;
    let text: string;
    try {
      text = readFileSync(join(cfg.rootDir ?? cfg.baseDir, row.path as string), 'utf8');
    } catch {
      continue; // vanished since the match; leave snippets/lines empty rather than throw
    }
    const { snippets, offset } = computeSnippets(text, bareTerms, charLimit, countLimit);
    row.snippets = snippets;
    if (row.lines == null) row.lines = featureEnabled(cfg, 'sections') ? await lineRangeFor(store, row.path as string, lineNumberAt(text, offset)) : null;
  }
}

// The declared or defaulted signals compose via RRF; `via` names which ones produced each row.
// `opts` arrives already resolved (config.ts:resolveSearch).
export async function search(store: Store, cfg: ResolvedConfig, terms: string, opts: SearchOptions = {}): Promise<Row[]> {
  validateSearchOptions(opts);
  const effective = resolveSearch(cfg, opts);
  const { k, signals } = effective;

  const allPaths = ((await (await store.prepare('SELECT "path" FROM frontmatter')).all()) as Array<{ path: string }>).map((r) => r.path);
  const scopePaths = await rawScope(store, cfg, opts, allPaths);
  const scopeActive = scopePaths.size < allPaths.length;
  // The set every candidate pool must be filtered to before truncation: scope narrowed by
  // --where, the same composition scopedPaths() gives the other commands.
  let allowedPaths: Set<string>;
  try {
    allowedPaths = await narrowByWhere(store, scopePaths, effective.where);
  } catch (err) {
    throw searchError(err as Error, terms, effective.where);
  }
  const fetch = Math.max(k * 3, 30);

  // A downloadable HF id proceeds -- getProvider fetches it lazily on consent. Only a
  // local path with missing files errors here, since nothing will ever fetch it for itself.
  const wantsVectors = signals.vectors !== undefined;
  if (wantsVectors) {
    const e = embedConfig(cfg); // validate.ts guarantees this is set whenever "vectors" is declared
    if (localModelMissing(e)) {
      throw new SenseError('EMBED_MODEL_MISSING', `preset "${effective.presetName}" searches with vectors, but the local model path "${e.model}" is missing ${MODEL_FILENAMES}; point embed.model at a directory containing them, or drop "vectors" from that preset's signals to search without them`);
    }
  }
  const semanticEnabled = wantsVectors && (await scopeHasEmbeddings(store, cfg, allowedPaths));

  // --where applies inside the candidate query (a post-filter would drop matches ranked past
  // the pool) and again on the final select, for link-derived rows.
  const scope = effective.where;
  const whereJoin = scope ? `JOIN frontmatter f ON f."path" = content.path` : '';
  const whereCond = scope ? `AND (${scope})` : '';
  // Filtered before LIMIT, not after, or scoped notes ranking below the global top-`fetch`
  // never reach the filter; joined against a temp table since real scopes exceed SQLITE_MAX_VARIABLE_NUMBER.
  if (scopeActive) await materializeScope(store, '_search_scope', scopePaths);
  const scopeCond = scopeActive ? `AND content.path IN (SELECT "path" FROM _search_scope)` : '';

  const candidates = new Map<string, { score: number; via: string }>();
  let matchRows: LexicalHit[] = [];
  const hasEmptyPhrase = [...terms.matchAll(/"([^"]*)"/g)].some((match) => !/[\p{L}\p{N}_]/u.test(match[1]));
  const hasBareSyntaxOnly = /[()]/u.test(terms.replace(/"[^"]*"/g, ' '));
  // A query that is only whitespace or punctuation has no lexical rows; other declared signals
  // compose normally. In particular, unspaced-script punctuation can rewrite to an empty MATCH.
  if (signals.words !== undefined && terms.trim() !== '' && (/[\p{L}\p{N}_]/u.test(terms) || hasBareSyntaxOnly) && !hasEmptyPhrase) {
    const syntaxError = bareTermSyntaxError(terms);
    if (syntaxError) throw syntaxError;
    try {
      matchRows = await wordsCandidates(store, candidates, terms, whereJoin, whereCond, scopeCond, fetch, signals.words);
    } catch (err) {
      throw searchError(err as Error, terms, scope);
    }
  }
  // Every store's lexical `snippets` is NULL; the snippet text is always computed below.
  // Distinguish from via='link' rows, which never appear in matchRows.
  const matchedPaths = new Set(matchRows.map((r) => r.path));

  if (signals.links !== undefined) await linksCandidates(store, candidates, matchRows, allPaths, allowedPaths, fetch, signals.links);

  let chunkLines = new Map<string, string>();
  let chunkSimilarity = new Map<string, number>();
  if (semanticEnabled) {
    ({ chunkLines, chunkSimilarity } = await vectorsCandidates(store, cfg, candidates, terms, fetch, allowedPaths, signals.vectors as number));
  }

  await store.exec('DROP TABLE IF EXISTS _search');
  // DOUBLE, not REAL: sqlite's REAL is an 8-byte double but duckdb's is a 4-byte float, and the
  // rounded score/similarity are printed at full precision in rows.
  await store.exec('CREATE TEMP TABLE _search ("path" TEXT PRIMARY KEY, score DOUBLE, via TEXT, lines TEXT, similarity DOUBLE)');
  if (candidates.size > 0) {
    await store.runBatch(
      'INSERT INTO _search ("path", score, via, lines, similarity) VALUES (?, ?, ?, ?, ?)',
      [...candidates].map(([path, c]) => [path, c.score, c.via, chunkLines.get(path) ?? null, chunkSimilarity.get(path) ?? null])
    );
  }

  // Reapplies --where even though _search is already scope+where filtered, since the join to
  // frontmatter is already needed for the path column.
  const where = scope ? `WHERE (${scope})` : '';
  // lines: semantic rows carry their chunk's range, lexical rows gain one below,
  // everything else stays null; similarity stays semantic-only.
  const similarityCol = semanticEnabled ? ', _search.similarity' : '';
  // NULL AS snippets holds this column's position (between summary and via) for every row;
  // overwritten below, always to an array, never left null (DESIGN.md).
  const selectStmt = await store.prepare(
    `SELECT f."path" AS path, content.title, content.summary, NULL AS snippets, _search.via, round(_search.score, 4) AS score, _search.lines${similarityCol}
       FROM _search JOIN frontmatter f ON f."path" = _search."path" JOIN content ON content.path = _search."path"
       ${where} ORDER BY _search.score DESC LIMIT ?`
  );
  const rows = (await selectStmt.all(k)) as Row[];
  for (const row of rows) row.snippets = [];

  await hydrateSearchRows(store, cfg, rows, matchedPaths, terms, opts);

  return rows;
}
