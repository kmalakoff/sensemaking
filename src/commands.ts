import { readFileSync } from 'node:fs';
import { join, matchesGlob } from 'node:path';
import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName, ResolvedConfig, SearchOverrides } from './config.ts';
import { anyPresetEmbeds, embedEnabled, featureEnabled, featureStates, presetNames, presetSemanticEnabled, resolveSearch } from './config.ts';
import { SenseError } from './errors.ts';
import { embedPending, hasEmbedding, modelPresent, semanticCandidates, similarNotes } from './features/embed.ts';
import { linkEdges } from './features/index.ts';
import { personalizedRank } from './graph.ts';
import type { Row } from './output.ts';
import { searchError } from './search-error.ts';

// The three commands: mapTree (orient), search (locate), peek (structure).
// Each returns data; cli.ts renders. All of them degrade when a feature is off.

const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';
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

// node:path's matchesGlob is experimental (stable behind an unstable-API flag) as of the
// engines floor (Node >=22.20); scope filtering only ever needs single-pattern matching, so
// it's used here in JS rather than running a directory walk in the query path.
function inScope(path: string, include: string[], exclude?: string[]): boolean {
  if (!include.some((g) => matchesGlob(path, g))) return false;
  if (exclude?.some((g) => matchesGlob(path, g))) return false;
  return true;
}

function scopeHasEmbeddings(db: DatabaseSync, cfg: ResolvedConfig, scopedPaths: Set<string>): boolean {
  if (!anyPresetEmbeds(cfg)) return false; // the embeddings table doesn't exist at all in this case
  const rows = db.prepare('SELECT DISTINCT "path" FROM embeddings').all() as Array<{ path: string }>;
  return rows.some((r) => scopedPaths.has(r.path));
}

// BM25 + link expansion + vectors, fused by reciprocal rank; `via` names the signal per row.
// `opts` arrives already resolved (config.ts:resolveSearch).
export async function search(db: DatabaseSync, cfg: ResolvedConfig, terms: string, opts: SearchOptions = {}): Promise<Row[]> {
  const effective = resolveSearch(cfg, opts);
  const { k, include, exclude } = effective;

  const allPaths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  // A preset scope reads the coverage reconcile indexed; re-matching globs here could disagree
  // with it. Only ad-hoc scope flags, which have no persisted coverage, pay the JS match.
  const adHocScope = opts.include !== undefined || opts.exclude !== undefined || opts.noExclude === true;
  const scopedPaths = adHocScope ? new Set(allPaths.filter((p) => inScope(p, include, exclude))) : new Set((db.prepare('SELECT "path" FROM preset_files WHERE preset = ?').all(effective.presetName) as Array<{ path: string }>).map((r) => r.path));
  // A scope narrower than the whole index needs a bigger candidate pool before filtering, or
  // filtering can starve k even though enough in-scope matches exist further down the ranked
  // list that a plain over-fetch wouldn't have reached.
  const scopeActive = scopedPaths.size < allPaths.length;
  const fetch = scopeActive ? Math.max(k * 5, 50) : Math.max(k * 3, 30);

  // Asking for vectors without a model is a misconfiguration, not a mode: degrading would make
  // the same search answer differently before and after a download. semantic:false never asks.
  const wantsVectors = effective.semantic && anyPresetEmbeds(cfg);
  if (wantsVectors && !modelPresent(cfg)) {
    throw new SenseError('EMBED_MODEL_MISSING', `preset "${effective.presetName}" searches with vectors, but the embedding model is not available; run \`sense download\`, or set "semantic": false on that preset to search on words and links`);
  }
  const semanticEnabled = wantsVectors && scopeHasEmbeddings(db, cfg, scopedPaths);

  // Terms pass verbatim to MATCH; invalid syntax errors rather than being rewritten. --where
  // applies inside the candidate query (a post-filter would drop matches ranked past the pool)
  // and again on the final select, for link-derived rows.
  const scope = effective.where;
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
  // Scope filtering happens in JS, on each candidate list, rather than in SQL: FTS5 match,
  // link expansion, and vector search all run unscoped above (cheap to over-fetch), then get
  // filtered here against the effective include/exclude before ranking is finalized.
  matchRows = matchRows.filter((r) => scopedPaths.has(r.path));

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
      .filter(([path, score]) => score > 1e-9 && scopedPaths.has(path))
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
    const vec = (await semanticCandidates(db, cfg, terms, fetch)).filter((v) => scopedPaths.has(v.path));
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

  // Already scope-filtered above; the final select reapplies --where only for link-derived
  // rows, which never passed through whereCond.
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

// The scope resolver for non-search commands (path, peek, map): same coverage rule search()
// applies (preset_files for a named preset, JS glob matching for an ad hoc include/exclude),
// then narrowed by the resolved `where`.
export function scopedPaths(db: DatabaseSync, cfg: ResolvedConfig, overrides: SearchOverrides): Set<string> {
  const effective = resolveSearch(cfg, overrides);
  const { include, exclude, where } = effective;
  const allPaths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  const adHocScope = overrides.include !== undefined || overrides.exclude !== undefined || overrides.noExclude === true;
  const paths = adHocScope ? new Set(allPaths.filter((p) => inScope(p, include, exclude))) : new Set((db.prepare('SELECT "path" FROM preset_files WHERE preset = ?').all(effective.presetName) as Array<{ path: string }>).map((r) => r.path));
  if (!where) return paths;
  const whereRows = db.prepare(`SELECT "path" FROM frontmatter f WHERE (${where})`).all() as Array<{ path: string }>;
  const wherePaths = new Set(whereRows.map((r) => r.path));
  return new Set([...paths].filter((p) => wherePaths.has(p)));
}

export interface PresetCoverage {
  name: string;
  files: number;
  embedded: number;
  // Reported so 0 embedded reads as "this scope declined vectors" rather than "not yet built".
  semantic: boolean;
}

// Indexing derives from presets, so the derivation stays visible. Read from preset_files, not
// recomputed from globs, so it reflects the cache rather than the config.
export function presetCoverage(db: DatabaseSync, cfg: ResolvedConfig): PresetCoverage[] {
  const embedActive = anyPresetEmbeds(cfg);
  return presetNames(cfg).map((name) => {
    const files = (db.prepare('SELECT COUNT(*) AS n FROM preset_files WHERE preset = ?').get(name) as { n: number }).n;
    const embedded = embedActive ? (db.prepare('SELECT COUNT(*) AS n FROM preset_files pf WHERE pf.preset = ? AND EXISTS (SELECT 1 FROM embeddings e WHERE e."path" = pf."path" AND e.vector IS NOT NULL)').get(name) as { n: number }).n : 0;
    return { name, files, embedded, semantic: presetSemanticEnabled(cfg, name) };
  });
}

export interface TreeMap {
  docs: { count: number; bytes: number };
  fields: Row[]; // top 20 by coverage; fieldsTotal carries the real count
  fieldsTotal: number;
  features: { on: FeatureName[]; off: FeatureName[] };
  presets: PresetCoverage[];
  hubs: Row[];
  recent: Row[];
}

const INTERNAL_COLUMNS = new Set(['path', '_mtime', '_size', '_rank', '_parse_error']);

// A result row is capped at SQLITE_MAX_COLUMN (2000, default); two aggregate expressions
// per field keeps a chunk's row safely under that regardless of how many fields the tree has.
const MAP_COLUMN_CHUNK = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Materializes the resolved scope into a temp table (same shape as traverse.ts's
// allowed_nodes) so every mapTree query can join/filter against it cheaply.
function setupMapScope(db: DatabaseSync, paths: Set<string>): void {
  db.exec('DROP TABLE IF EXISTS _map_scope');
  db.exec('CREATE TEMP TABLE _map_scope ("path" TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO _map_scope SELECT DISTINCT value FROM json_each(?1)').run(JSON.stringify([...paths]));
}

// What is this scope: fixed-size output regardless of tree size. Coverage and features stay
// global -- they describe the tree, not the current question.
export function mapTree(db: DatabaseSync, cfg: ResolvedConfig, overrides: SearchOverrides = {}): TreeMap {
  setupMapScope(db, scopedPaths(db, cfg, overrides));
  const scopeWhere = 'WHERE "path" IN (SELECT "path" FROM _map_scope)';
  const scopeAnd = 'AND f."path" IN (SELECT "path" FROM _map_scope)';

  const docs = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM("_size"), 0) AS bytes FROM frontmatter ${scopeWhere}`).get() as { count: number; bytes: number };

  const columns = (db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>).map((r) => r.name).filter((name) => !INTERNAL_COLUMNS.has(name));
  // Observed types, not declared: SQLite types per value, so a field can be text in most notes
  // and numeric in a few. One aggregate scan per chunk of columns; FILTER matches COUNT's nulls.
  const allFields: Row[] = [];
  for (const group of chunk(columns, MAP_COLUMN_CHUNK)) {
    const exprs = group.map((name, i) => {
      const quoted = `"${name.split('"').join('""')}"`;
      return `COUNT(${quoted}) AS n${i}, GROUP_CONCAT(DISTINCT typeof(${quoted})) FILTER (WHERE ${quoted} IS NOT NULL) AS t${i}`;
    });
    const result = db.prepare(`SELECT ${exprs.join(', ')} FROM frontmatter ${scopeWhere}`).get() as Record<string, number | string | null>;
    group.forEach((name, i) => allFields.push({ field: name, coverage: result[`n${i}`] as number, type: (result[`t${i}`] as string) ?? '' }));
  }
  allFields.sort((a, b) => (b.coverage as number) - (a.coverage as number));
  const fields = allFields.slice(0, 20);

  const hubs = featureEnabled(cfg, 'rank') ? (db.prepare(`SELECT f."path" AS path, round(f."_rank" * 100, 2) AS rank, content.title FROM frontmatter f JOIN content ON content.path = f."path" WHERE f."_rank" IS NOT NULL ${scopeAnd} ORDER BY f."_rank" DESC LIMIT 8`).all() as Row[]) : [];

  const recent = db.prepare(`SELECT "path", datetime("_mtime" / 1000, 'unixepoch') AS modified FROM frontmatter ${scopeWhere} ORDER BY "_mtime" DESC LIMIT 5`).all() as Row[];

  return { docs, fields, fieldsTotal: allFields.length, features: featureStates(cfg), presets: presetCoverage(db, cfg), hubs, recent };
}

// Note resolution shared by peek and path: an exact path, or a unique basename (case
// insensitive, .md stripped).
export function resolveNote(paths: string[], arg: string): string {
  const exact = paths.find((p) => p === arg);
  if (exact) return exact;
  const base = posix.basename(arg).replace(/\.md$/i, '').toLowerCase();
  const matches = paths.filter((p) => posix.basename(p).replace(/\.md$/i, '').toLowerCase() === base);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new SenseError('NOTE_AMBIGUOUS', `"${arg}" is ambiguous: ${matches.join(', ')}`);
  throw new SenseError('NOTE_NOT_FOUND', `no note matches "${arg}"`);
}

export interface Peek {
  path: string;
  tokens: number;
  frontmatter: Row;
  // Set when the note's frontmatter was refused, so an empty frontmatter block reads as "did
  // not parse" rather than "has none". Same reason `_parse_error` sits in the row.
  parseError: string | null;
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
  // Bounded k-hop expansion beyond the immediate ring already shown by outbound/backlinks
  // (depth starts at 2).
  off: FeatureName[]; // disabled features whose blocks are omitted (not empty)
}

const PEEK_LIST_LIMIT = 20;

// peek: everything about one note except its prose -- frontmatter, outline with line
// ranges + token estimates (so the follow-up Read is a range, not the file), links both ways.
export function peek(db: DatabaseSync, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides = {}): Peek {
  const paths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  const path = resolveNote(paths, pathArg);

  const row = db.prepare('SELECT * FROM frontmatter WHERE "path" = ?').get(path) as Row;
  const parseError = (row._parse_error as string | null) ?? null;
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
  const _allowed = scopedPaths(db, cfg, overrides);
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
    parseError,
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

// Notes most similar by cosine, excluding self and everything already linked either way.
// Its own command, not a peek section: a full embeddings scan is ~480ms at 26k notes.
export async function relatedNotes(db: DatabaseSync, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides, k: number): Promise<Array<{ path: string; similarity: number }>> {
  const paths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
  const path = resolveNote(paths, pathArg);

  const outbound = (db.prepare('SELECT DISTINCT dst FROM links WHERE src = ? AND dst IS NOT NULL').all(path) as Array<{ dst: string }>).map((r) => r.dst);
  const backlinks = (db.prepare('SELECT DISTINCT src FROM links WHERE dst = ?').all(path) as Array<{ src: string }>).map((r) => r.src);
  const exclude = new Set([path, ...outbound, ...backlinks]);

  // Vectors are the only signal `related` has, so every way of not having them is an error
  // naming the cause. An empty table then means one thing: nothing near in meaning that this
  // note does not already link to, which is a real answer.
  const effective = resolveSearch(cfg, overrides);
  if (!embedEnabled(cfg)) {
    throw new SenseError('EMBED_DISABLED', 'related ranks notes by meaning, and this tree has no embedding model; add an "embed" block naming one to sense.config.json, then run `sense download` (search works without it, on words and links)');
  }
  // search gates on the same flag (see wantsVectors above); reading it here too keeps
  // `semantic: false` meaning one thing. Without this, an overlapping semantic-on preset's
  // vectors would answer for a scope that declined them.
  if (!effective.semantic) {
    throw new SenseError('PRESET_NOT_SEMANTIC', `preset "${effective.presetName}" sets "semantic": false, so this scope has no vectors and related has no other signal; search it instead (words and links), or set semantic back on for that preset`);
  }
  if (!modelPresent(cfg)) {
    throw new SenseError('EMBED_MODEL_MISSING', 'related ranks notes by meaning, so it needs the embedding model, which is not downloaded; run `sense download` (search still works without it, on words and links)');
  }
  const allowed = scopedPaths(db, cfg, overrides);
  // Top up pending rows before the seed check, or a fresh index reports every note as
  // having no indexed text until some search has run.
  await embedPending(db, cfg, cfg.baseDir);
  if (!hasEmbedding(db, path)) {
    throw new SenseError('NOTE_NOT_EMBEDDED', `${path} has no indexed text to compare -- a note that is frontmatter only, or empty, has nothing to rank by meaning`);
  }
  if (!scopeHasEmbeddings(db, cfg, allowed)) return [];
  return similarNotes(db, cfg, path, { exclude, allowed, k });
}
