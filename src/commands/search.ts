import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import { embedConfig, featureEnabled, resolveSearch } from '../config/index.ts';
import { localModelMissing, MODEL_FILENAMES } from '../embed/store.ts';
import { SenseError } from '../errors.ts';
import type { Row } from '../output/output.ts';
import { searchError } from '../output/search-error.ts';
import type { LexicalHit, Store } from '../store/types.ts';
import { materializeScope, narrowByWhere, rawScope, scopeHasEmbeddings } from './scope.ts';
import { linksCandidates, vectorsCandidates, wordsCandidates } from './signals.ts';

// snippet() re-tokenizes each candidate doc, superlinearly: ~10s for one 1MB doc
// (benchmark/reports/2026-08-23-0.13.2-hub-release-battery.md). Past this bound, rows get the JS excerpt.
const EXCERPT_WINDOW = 160;

// Bare terms from an FTS5 query string: strips operators/quoting so the oversized-doc excerpt
// scan matches the same words the query matched on, not FTS5 syntax.
function extractBareTerms(query: string): string[] {
  const cleaned = query
    .replace(/"/g, ' ')
    .replace(/[()*]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b(\/\d+)?/gi, ' ');
  return cleaned
    .split(/\s+/)
    .map((tok) => tok.replace(/^[A-Za-z_]\w*:/, '')) // column filter, e.g. title:term
    .map((tok) => tok.toLowerCase().trim())
    .filter((tok) => tok.length > 0);
}

function findOccurrences(haystackLower: string, terms: string[]): Array<{ start: number; end: number; term: string }> {
  const occ: Array<{ start: number; end: number; term: string }> = [];
  for (const term of terms) {
    let idx = 0;
    for (;;) {
      const found = haystackLower.indexOf(term, idx);
      if (found === -1) break;
      occ.push({ start: found, end: found + term.length, term });
      idx = found + term.length;
    }
  }
  // Longest span first at equal start, so "tests" beats its substring "test" and the
  // whole word gets highlighted; the emit loop then absorbs the shorter overlap.
  return occ.sort((a, b) => a.start - b.start || b.end - a.end);
}

// Slides a window over the sorted occurrences, same semantics as FTS5's own best-window
// pick: most distinct terms, ties broken by most total hits.
function bestWindowStart(occ: Array<{ start: number; end: number; term: string }>, windowSize: number): number {
  let best = occ[0].start;
  let bestDistinct = 0;
  let bestCount = 0;
  for (let i = 0; i < occ.length; i++) {
    const winEnd = occ[i].start + windowSize;
    const seen = new Set<string>();
    let count = 0;
    for (let j = i; j < occ.length && occ[j].start < winEnd; j++) {
      seen.add(occ[j].term);
      count++;
    }
    if (seen.size > bestDistinct || (seen.size === bestDistinct && count > bestCount)) {
      best = occ[i].start;
      bestDistinct = seen.size;
      bestCount = count;
    }
  }
  return best;
}

// snippet()-shaped excerpt: matched terms wrapped in «», … at cut edges. Linear in doc
// length, only run for rows actually returned (<= k), unlike snippet()'s per-row cost.
function computeExcerpt(text: string, terms: string[]): { excerpt: string; offset: number } {
  const occ = findOccurrences(text.toLowerCase(), terms);
  if (occ.length === 0) {
    // Raw substring scan, not porter-stemmed: a doc matched only through a stemmed variant
    // finds no occurrence here, so fall back to the doc's start, unmarked.
    const end = Math.min(text.length, EXCERPT_WINDOW);
    return { excerpt: `${text.slice(0, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`, offset: 0 };
  }
  const start = bestWindowStart(occ, EXCERPT_WINDOW);
  const end = Math.min(text.length, start + EXCERPT_WINDOW);
  let out = '';
  let cursor = start;
  for (const o of occ) {
    if (o.start < start || o.end > end) continue;
    // Occurrences of duplicate or substring-overlapping terms ("test tests") can overlap;
    // emitting each would duplicate document text. Keep the first, absorb the rest.
    if (o.start < cursor) continue;
    out += `${text.slice(cursor, o.start)}«${text.slice(o.start, o.end)}»`;
    cursor = o.end;
  }
  out += text.slice(cursor, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return { excerpt: `${prefix}${out.replace(/\s+/g, ' ')}${suffix}`, offset: start };
}

function lineNumberAt(text: string, offset: number): number {
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
}

// The declared or defaulted signals compose via RRF; `via` names which ones produced each row.
// `opts` arrives already resolved (config.ts:resolveSearch).
export async function search(store: Store, cfg: ResolvedConfig, terms: string, opts: SearchOptions = {}): Promise<Row[]> {
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
  // A query that is only whitespace has no searchable words: zero lexical rows, and the other
  // signals compose normally.
  if (signals.words !== undefined && terms.trim() !== '') {
    try {
      matchRows = await wordsCandidates(store, candidates, terms, whereJoin, whereCond, scopeCond, fetch, signals.words);
    } catch (err) {
      throw searchError(err as Error, terms, scope);
    }
  }
  const hits = new Map(matchRows.map((r) => [r.path, r.hit]));
  // hit === null here means the bound suppressed snippet(), not "no match" -- distinguish
  // from via='link' rows (never in matchRows, so absent from this set) below.
  const oversized = new Set(matchRows.filter((r) => r.hit === null).map((r) => r.path));

  if (signals.links !== undefined) await linksCandidates(store, candidates, matchRows, allPaths, allowedPaths, fetch, signals.links);

  let chunkLines = new Map<string, string>();
  let chunkSimilarity = new Map<string, number>();
  if (semanticEnabled) {
    ({ chunkLines, chunkSimilarity } = await vectorsCandidates(store, cfg, candidates, terms, fetch, allowedPaths, signals.vectors as number));
  }

  await store.exec('DROP TABLE IF EXISTS _search');
  // DOUBLE, not REAL: sqlite's REAL is an 8-byte double but duckdb's is a 4-byte float, and the
  // rounded score/similarity are printed at full precision in rows.
  await store.exec('CREATE TEMP TABLE _search ("path" TEXT PRIMARY KEY, score DOUBLE, via TEXT, hit TEXT, lines TEXT, similarity DOUBLE)');
  if (candidates.size > 0) {
    await store.runBatch(
      'INSERT INTO _search ("path", score, via, hit, lines, similarity) VALUES (?, ?, ?, ?, ?, ?)',
      [...candidates].map(([path, c]) => [path, c.score, c.via, hits.get(path) ?? null, chunkLines.get(path) ?? null, chunkSimilarity.get(path) ?? null])
    );
  }

  // Reapplies --where even though _search is already scope+where filtered, since the join to
  // frontmatter is already needed for the path column.
  const where = scope ? `WHERE (${scope})` : '';
  // lines: semantic rows carry their chunk's range, oversized-doc lexical rows gain one
  // below, everything else stays null; similarity stays semantic-only.
  const similarityCol = semanticEnabled ? ', _search.similarity' : '';
  const selectStmt = await store.prepare(
    `SELECT f."path" AS path, content.title, content.summary, _search.hit, _search.via, round(_search.score, 4) AS score, _search.lines${similarityCol}
       FROM _search JOIN frontmatter f ON f."path" = _search."path" JOIN content ON content.path = _search."path"
       ${where} ORDER BY _search.score DESC LIMIT ?`
  );
  const rows = (await selectStmt.all(k)) as Row[];

  if (oversized.size > 0) {
    const bareTerms = extractBareTerms(terms);
    for (const row of rows) {
      if (row.hit !== null || !oversized.has(row.path as string)) continue;
      let text: string;
      try {
        text = readFileSync(join(cfg.baseDir, row.path as string), 'utf8');
      } catch {
        continue; // vanished since the match; leave hit/lines null rather than throw
      }
      const { excerpt, offset } = computeExcerpt(text, bareTerms);
      row.hit = excerpt;
      if (row.lines == null) row.lines = featureEnabled(cfg, 'sections') ? await lineRangeFor(store, row.path as string, lineNumberAt(text, offset)) : null;
    }
  }

  return rows;
}
