import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName, ResolvedConfig } from './config.ts';
import { featureEnabled, featureStates } from './config.ts';
import { SenseError } from './errors.ts';
import { semanticCandidates } from './features/embed.ts';
import { linkEdges } from './features/index.ts';
import { personalizedRank } from './graph.ts';
import type { Row } from './output.ts';
import { searchError } from './search-error.ts';

// The three layer commands: mapTree (orient), find (locate), peek (structure).
// Each returns data; cli.ts renders. All of them degrade when a feature is off.

const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';
const RRF_K = 60;

// FTS5 snippet() re-tokenizes the whole doc per candidate row, superlinearly: measured
// 2ms at 4KB docs but 189ms at 64KB for one query's pool, and ~10s for a single 1MB doc
// (plans/performance-findings.md finding A). 16KB keeps the whole pool's snippet cost in
// the low-ms range; bigger docs get the JS-computed excerpt, linear and only for the rows
// actually returned.
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

export interface FindOptions {
  k?: number;
  where?: string; // SQL fragment against frontmatter alias `f`, e.g. "f.status = 'active'"
  semantic?: boolean; // invoke vector expansion (requires features.embed); rows gain via 'vector' and a lines column
}

// Layer 1: BM25 + link-graph expansion, fused by reciprocal rank. `via` says which
// signal produced each row so the agent knows what evidence it is trusting.
// Semantic expansion is per-query opt-in: without opts.semantic the result is
// byte-for-byte independent of the embed feature.
export async function find(db: DatabaseSync, cfg: ResolvedConfig, terms: string, opts: FindOptions = {}): Promise<Row[]> {
  const k = opts.k ?? 10;
  const fetch = Math.max(k * 3, 30);

  // Terms pass verbatim to FTS5 MATCH: bare words AND-join, operators are the caller's.
  // Invalid syntax propagates as an error, zero matches return zero -- no silent rewrites.
  // --where applies inside the candidate query (a post-filter over the top-N would drop
  // matches ranked past the pool) and again on the final select for link-derived rows.
  // An explicit --where replaces the tree's declared default rather than ANDing with it,
  // so a caller can always widen back to the whole tree.
  const scope = opts.where ?? cfg.defaults?.find?.where;
  const whereJoin = scope ? `JOIN frontmatter f ON f."path" = content.path` : '';
  const whereCond = scope ? `AND (${scope})` : '';
  // Docs past SNIPPET_BOUND skip snippet() entirely -- SQLite
  // short-circuits the untaken CASE branch, so it's never invoked on them.
  const matchSql = `SELECT content.path AS path, CASE WHEN length(content.text) <= ${SNIPPET_BOUND} THEN snippet(content, -1, '«', '»', '…', 10) ELSE NULL END AS hit FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ORDER BY ${WEIGHTED_BM25} LIMIT ${fetch}`;
  let matchRows: Array<{ path: string; hit: string | null }>;
  try {
    matchRows = db.prepare(matchSql).all(terms) as Array<{ path: string; hit: string | null }>;
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
    // `linked` gates the label only, not the score: PPR restart mass gives every seed a
    // nonzero rank even without an incident edge, which is not link evidence — but dropping
    // that mass from the score list reweights fusion toward connectivity and measurably
    // wrecks ranking on link-dense corpora (FEVER hit@10 0.997 -> 0.907; fusion-tuning.md).
    const linked = new Set(edges.flat());
    const nodes = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
    const seeds = new Map(matchRows.map((r, i) => [r.path, 1 / (i + 1)]));
    const ranked = [...personalizedRank(nodes, edges, seeds)]
      .filter(([, score]) => score > 1e-9)
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
  if (opts.semantic) {
    const vec = await semanticCandidates(db, cfg, terms, fetch);
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

  db.exec('DROP TABLE IF EXISTS _find');
  db.exec('CREATE TEMP TABLE _find ("path" TEXT PRIMARY KEY, score REAL, via TEXT, hit TEXT, lines TEXT, similarity REAL)');
  const insert = db.prepare('INSERT INTO _find ("path", score, via, hit, lines, similarity) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [path, c] of candidates) insert.run(path, c.score, c.via, hits.get(path) ?? null, chunkLines.get(path) ?? null, chunkSimilarity.get(path) ?? null);

  const where = scope ? `WHERE ${scope}` : '';
  // lines is always present now: semantic rows carry their chunk's range, oversized-doc
  // lexical rows gain one below, everything else stays null. similarity stays semantic-only.
  const similarityCol = opts.semantic ? ', _find.similarity' : '';
  const rows = db
    .prepare(
      `SELECT f."path" AS path, content.title, content.summary, _find.hit, _find.via, round(_find.score, 4) AS score, _find.lines${similarityCol}
       FROM _find JOIN frontmatter f ON f."path" = _find."path" JOIN content ON content.path = _find."path"
       ${where} ORDER BY _find.score DESC LIMIT ?`
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

export interface TreeMap {
  docs: { count: number; bytes: number };
  fields: Row[]; // top 20 by coverage; fieldsTotal carries the real count
  fieldsTotal: number;
  features: { on: FeatureName[]; off: FeatureName[] };
  hubs: Row[];
  recent: Row[];
}

const INTERNAL_COLUMNS = new Set(['path', '_mtime', '_size', '_rank']);

// A result row is capped at SQLITE_MAX_COLUMN (2000, default); two aggregate expressions
// per field keeps a chunk's row safely under that regardless of how many fields the tree has.
const MAP_COLUMN_CHUNK = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Layer 0: what is this tree. Fixed-size output regardless of tree size.
export function mapTree(db: DatabaseSync, cfg: ResolvedConfig): TreeMap {
  const docs = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM("_size"), 0) AS bytes FROM frontmatter').get() as { count: number; bytes: number };

  const columns = (db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>).map((r) => r.name).filter((name) => !INTERNAL_COLUMNS.has(name));
  // Observed storage class, not a declared one: these columns are added dynamically and
  // SQLite types per value, so a field can be text in most notes and numeric in a few.
  // Listing every distinct type makes both the type and any drift visible.
  // One aggregate scan per chunk of columns rather than one scan per column: COUNT already
  // ignores NULL, and FILTER keeps typeof() looking only at the non-null rows COUNT counted,
  // matching the old per-column `WHERE ... IS NOT NULL` exactly.
  const allFields: Row[] = [];
  for (const group of chunk(columns, MAP_COLUMN_CHUNK)) {
    const exprs = group.map((name, i) => {
      const quoted = `"${name.split('"').join('""')}"`;
      return `COUNT(${quoted}) AS n${i}, GROUP_CONCAT(DISTINCT typeof(${quoted})) FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
    });
    const result = db.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter`).get() as Record<string, number | string | null>;
    group.forEach((name, i) => allFields.push({ field: name, coverage: result[`n${i}`] as number, type: (result[`t${i}`] as string) ?? '' }));
  }
  allFields.sort((a, b) => (b.coverage as number) - (a.coverage as number));
  const fields = allFields.slice(0, 20);

  const hubs = featureEnabled(cfg, 'rank') ? (db.prepare(`SELECT f."path" AS path, round(f."_rank" * 100, 2) AS rank, content.title FROM frontmatter f JOIN content ON content.path = f."path" WHERE f."_rank" IS NOT NULL ORDER BY f."_rank" DESC LIMIT 8`).all() as Row[]) : [];

  const recent = db.prepare(`SELECT "path", datetime("_mtime" / 1000, 'unixepoch') AS modified FROM frontmatter ORDER BY "_mtime" DESC LIMIT 5`).all() as Row[];

  return { docs, fields, fieldsTotal: allFields.length, features: featureStates(cfg), hubs, recent };
}

export interface Peek {
  path: string;
  tokens: number;
  frontmatter: Row;
  sections: Row[];
  outbound: string[];
  backlinks: string[];
  unresolved: string[];
  // Totals before truncation: a hub can have thousands of backlinks (or a note thousands of
  // headings), and peek's whole point is bounded output. Query the sections/links tables
  // directly for the full list.
  sectionsTotal: number;
  outboundTotal: number;
  backlinksTotal: number;
  unresolvedTotal: number;
  off: FeatureName[]; // disabled features whose blocks are omitted (not empty)
}

const PEEK_LIST_LIMIT = 20;

// Layer 2: everything about one note except its prose -- frontmatter, outline with line
// ranges + token estimates (so the follow-up Read is a range, not the file), links both ways.
export function peek(db: DatabaseSync, cfg: ResolvedConfig, pathArg: string): Peek {
  const paths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  let path = paths.find((p) => p === pathArg);
  if (!path) {
    const base = posix.basename(pathArg).replace(/\.md$/i, '').toLowerCase();
    const matches = paths.filter((p) => posix.basename(p).replace(/\.md$/i, '').toLowerCase() === base);
    if (matches.length === 1) path = matches[0];
    else if (matches.length > 1) throw new SenseError('NOTE_AMBIGUOUS', `"${pathArg}" is ambiguous: ${matches.join(', ')}`);
    else throw new SenseError('NOTE_NOT_FOUND', `no note matches "${pathArg}"`);
  }

  const row = db.prepare('SELECT * FROM frontmatter WHERE "path" = ?').get(path) as Row;
  const frontmatter: Row = {};
  for (const [key, value] of Object.entries(row)) {
    if (!INTERNAL_COLUMNS.has(key) && value !== null) frontmatter[key] = value;
  }

  const sectionsTotal = featureEnabled(cfg, 'sections') ? (db.prepare('SELECT COUNT(*) AS n FROM sections WHERE "path" = ?').get(path) as { n: number }).n : 0;
  const sections = featureEnabled(cfg, 'sections') ? (db.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx LIMIT ?').all(path, PEEK_LIST_LIMIT) as Row[]) : [];

  let outbound: string[] = [];
  let backlinks: string[] = [];
  let unresolved: string[] = [];
  let backlinksTotal = 0;
  if (featureEnabled(cfg, 'links')) {
    const out = db.prepare('SELECT target, dst FROM links WHERE src = ? ORDER BY target').all(path) as Array<{ target: string; dst: string | null }>;
    outbound = [...new Set(out.filter((l) => l.dst !== null).map((l) => l.dst as string))];
    unresolved = out.filter((l) => l.dst === null).map((l) => l.target);
    backlinksTotal = (db.prepare('SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = ?').get(path) as { n: number }).n;
    backlinks = (db.prepare('SELECT DISTINCT src FROM links WHERE dst = ? ORDER BY src LIMIT ?').all(path, PEEK_LIST_LIMIT) as Array<{ src: string }>).map((r) => r.src);
  }

  return {
    path,
    tokens: Math.ceil(((row._size as number) ?? 0) / 4),
    frontmatter,
    sections,
    outbound: outbound.slice(0, PEEK_LIST_LIMIT),
    backlinks,
    unresolved: unresolved.slice(0, PEEK_LIST_LIMIT),
    sectionsTotal,
    outboundTotal: outbound.length,
    backlinksTotal,
    unresolvedTotal: unresolved.length,
    off: (['sections', 'links'] as FeatureName[]).filter((name) => !featureEnabled(cfg, name)),
  };
}
