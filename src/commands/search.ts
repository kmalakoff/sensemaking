import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedConfig } from '../config/index.ts';
import { anyPresetEmbeds, contentTokenize, featureEnabled, resolveSearch } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { modelPresent, semanticCandidates } from '../features/embed.ts';
import { linkEdges } from '../features/index.ts';
import { personalizedRank } from '../graph.ts';
import type { Row } from '../output.ts';
import { searchError } from '../search-error.ts';
import { segmentMatch } from '../segment.ts';
import { materializeScope, narrowByWhere, rawScope, scopeHasEmbeddings } from './scope.ts';

// Mirrors the main columns onto the sidecars, so a title match found through title_seg ranks
// like a title match found through title, not like a body match.
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0, 0, 10.0, 5.0, 1.0)';
const RRF_K = 60;

// snippet() re-tokenizes each candidate doc, superlinearly: ~10s for one 1MB doc
// (BENCHMARKING.md). Past this bound, rows get the linear JS excerpt instead.
const SNIPPET_BOUND = 16_384;
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
    // This is a raw substring scan, not porter-stemmed: a doc matched only through a
    // stemmed variant (query "negotiate" vs doc "negotiating") finds no occurrence here.
    // Fall back to the doc's start, unmarked, rather than claim a match that isn't there.
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

function lineRangeFor(db: DatabaseSync, path: string, line: number): string | null {
  const row = db.prepare('SELECT start_line, end_line FROM sections WHERE "path" = ? AND start_line <= ? AND end_line >= ? ORDER BY start_line DESC LIMIT 1').get(path, line, line) as { start_line: number; end_line: number } | undefined;
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

// BM25 + link expansion + vectors, fused by reciprocal rank; `via` names the signal per row.
// `opts` arrives already resolved (config.ts:resolveSearch).
export async function search(db: DatabaseSync, cfg: ResolvedConfig, terms: string, opts: SearchOptions = {}): Promise<Row[]> {
  const effective = resolveSearch(cfg, opts);
  const { k } = effective;

  const allPaths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  const scopePaths = rawScope(db, cfg, opts, allPaths);
  const scopeActive = scopePaths.size < allPaths.length;
  // The set every candidate pool must be filtered to before truncation: scope narrowed by
  // --where, the same composition scopedPaths() gives the other commands. Runs the same where
  // fragment matchSql does, so a bad column gets the same attributed error either way.
  let allowedPaths: Set<string>;
  try {
    allowedPaths = narrowByWhere(db, scopePaths, effective.where);
  } catch (err) {
    throw searchError(err as Error, terms, effective.where);
  }
  const fetch = Math.max(k * 3, 30);

  // Asking for vectors without a model is a misconfiguration, not a mode: degrading would make
  // the same search answer differently before and after a download. semantic:false never asks.
  const wantsVectors = effective.semantic && anyPresetEmbeds(cfg);
  if (wantsVectors && !modelPresent(cfg)) {
    throw new SenseError('EMBED_MODEL_MISSING', `preset "${effective.presetName}" searches with vectors, but the embedding model is not available; run \`sense download\`, or set "semantic": false on that preset to search on words and links`);
  }
  const semanticEnabled = wantsVectors && scopeHasEmbeddings(db, cfg, allowedPaths);

  // Terms pass to MATCH as written, with one transform: a run of text whose language marks no
  // word boundaries becomes a quoted grapheme phrase (and a title:/summary:/text: qualifier
  // ahead of it retargets its _seg column), matching how it was indexed. Text that already
  // carries boundaries comes through untouched, so this is a no-op for the languages that
  // never needed it. Gated on the same predicate that decided whether the sidecars were
  // populated (contentTokenize(cfg) === undefined), so index and query can't disagree. Invalid
  // syntax still errors rather than being rewritten.
  // --where
  // applies inside the candidate query (a post-filter would drop matches ranked past the pool)
  // and again on the final select, for link-derived rows.
  const scope = effective.where;
  const whereJoin = scope ? `JOIN frontmatter f ON f."path" = content.path` : '';
  const whereCond = scope ? `AND (${scope})` : '';
  // A scope narrower than the whole index must filter the candidate pool before LIMIT, not
  // after -- otherwise scoped notes ranking below the global top-`fetch` never reach the
  // filter. A join against a temp table, not a bound parameter list: real scopes run to
  // thousands of paths, past SQLITE_MAX_VARIABLE_NUMBER on older builds.
  if (scopeActive) materializeScope(db, '_search_scope', scopePaths);
  const scopeCond = scopeActive ? `AND content.path IN (SELECT "path" FROM _search_scope)` : '';
  // Docs past SNIPPET_BOUND skip snippet() entirely -- SQLite
  // short-circuits the untaken CASE branch, so it's never invoked on them.
  // Column 2 (text), not -1 (best column): -1 could surface a _seg sidecar as the excerpt,
  // which is machine-spaced and not what the author wrote. A row that matches only in a
  // sidecar gets an unhighlighted text excerpt below instead -- a stated cost.
  const matchSql = `SELECT content.path AS path, CASE WHEN length(content.text) <= ${SNIPPET_BOUND} THEN snippet(content, 2, '«', '»', '…', 10) ELSE NULL END AS hit FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ${scopeCond} ORDER BY ${WEIGHTED_BM25} LIMIT ${fetch}`;
  const query = contentTokenize(cfg) === undefined ? segmentMatch(terms) : terms;
  let matchRows: Array<{ path: string; hit: string | null }>;
  try {
    matchRows = db.prepare(matchSql).all(query) as Array<{ path: string; hit: string | null }>;
  } catch (err) {
    throw searchError(err as Error, terms, scope);
  }

  const hits = new Map(matchRows.map((r) => [r.path, r.hit]));
  // hit === null here means the bound suppressed snippet(), not "no match" -- distinguish
  // from via='link' rows (never in matchRows, so absent from this set) below.
  const oversized = new Set(matchRows.filter((r) => r.hit === null).map((r) => r.path));
  const candidates = new Map<string, { score: number; via: string }>();
  matchRows.forEach((r, i) => {
    candidates.set(r.path, { score: 1 / (RRF_K + i), via: 'match' });
  });

  const edges = featureEnabled(cfg, 'links') && matchRows.length > 0 ? linkEdges(db) : [];
  if (edges.length > 0) {
    // Gates the label only, not the score: restart mass ranks every seed without an incident
    // edge, but dropping it from the score reweights fusion (FEVER hit@10 0.997 -> 0.907).
    const linked = new Set(edges.flat());
    const seeds = new Map(matchRows.map((r, i) => [r.path, 1 / (i + 1)]));
    const ranked = [...personalizedRank(allPaths, edges, seeds)]
      .filter(([path, score]) => score > 1e-9 && allowedPaths.has(path))
      .sort((a, b) => b[1] - a[1])
      .slice(0, fetch);
    ranked.forEach(([path], i) => {
      const existing = candidates.get(path);
      if (existing) {
        existing.score += 1 / (RRF_K + i);
        if (linked.has(path)) existing.via = 'match+link';
      } else {
        candidates.set(path, { score: 1 / (RRF_K + i), via: 'link' });
      }
    });
  }

  // Vector expansion, invoked only: a third RRF list at the swept flat-region constants
  // (weight 1, pool = fetch). Each row carries its best chunk's line range.
  const chunkLines = new Map<string, string>();
  const chunkSimilarity = new Map<string, number>();
  if (semanticEnabled) {
    const vec = await semanticCandidates(db, cfg, terms, fetch, allowedPaths);
    vec.forEach(({ path, lines, similarity }, i) => {
      chunkLines.set(path, lines);
      chunkSimilarity.set(path, similarity);
      const existing = candidates.get(path);
      if (existing) {
        existing.score += 1 / (RRF_K + i);
        existing.via = `${existing.via}+vector`;
      } else {
        candidates.set(path, { score: 1 / (RRF_K + i), via: 'vector' });
      }
    });
  }

  db.exec('DROP TABLE IF EXISTS _search');
  db.exec('CREATE TEMP TABLE _search ("path" TEXT PRIMARY KEY, score REAL, via TEXT, hit TEXT, lines TEXT, similarity REAL)');
  const insert = db.prepare('INSERT INTO _search ("path", score, via, hit, lines, similarity) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [path, c] of candidates) insert.run(path, c.score, c.via, hits.get(path) ?? null, chunkLines.get(path) ?? null, chunkSimilarity.get(path) ?? null);

  // All three candidate paths (match, link, vector) already filtered to scope+where before
  // reaching _search; this reapplies --where anyway since the join to frontmatter is already
  // needed for the path column.
  const where = scope ? `WHERE (${scope})` : '';
  // lines is always present now: semantic rows carry their chunk's range, oversized-doc
  // lexical rows gain one below, everything else stays null. similarity stays semantic-only.
  const similarityCol = semanticEnabled ? ', _search.similarity' : '';
  const rows = db
    .prepare(
      `SELECT f."path" AS path, content.title, content.summary, _search.hit, _search.via, round(_search.score, 4) AS score, _search.lines${similarityCol}
       FROM _search JOIN frontmatter f ON f."path" = _search."path" JOIN content ON content.path = _search."path"
       ${where} ORDER BY _search.score DESC LIMIT ?`
    )
    .all(k) as Row[];

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
      if (row.lines == null) row.lines = featureEnabled(cfg, 'sections') ? lineRangeFor(db, row.path as string, lineNumberAt(text, offset)) : null;
    }
  }

  return rows;
}
