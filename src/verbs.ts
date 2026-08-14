import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { featureEnabled } from './config.ts';
import { SenseError } from './errors.ts';
import { semanticCandidates } from './features/embed.ts';
import { linkEdges } from './features/index.ts';
import { personalizedRank } from './graph.ts';
import type { Row } from './output.ts';

// The three layer verbs: mapTree (orient), find (locate), peek (structure).
// Each returns data; cli.ts renders. All of them degrade when a feature is off.

const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';
const RRF_K = 60;

export interface FindOptions {
  k?: number;
  where?: string; // SQL fragment against frontmatter alias `f`, e.g. "f.status = 'active'"
  semantic?: boolean; // invoke vector expansion (requires features.embed); rows gain via 'vector' and a lines column
}

// Layer 1: BM25 + link-graph expansion, fused by reciprocal rank. `via` says which
// signal produced each row so the agent knows what evidence it is trusting.
// Semantic expansion is per-query opt-in: without opts.semantic the result is
// byte-for-byte independent of the embed feature.
export async function find(db: DatabaseSync, cfg: Config, terms: string, opts: FindOptions = {}): Promise<Row[]> {
  const k = opts.k ?? 10;
  const fetch = Math.max(k * 3, 30);

  // Terms pass verbatim to FTS5 MATCH: bare words AND-join, operators are the caller's.
  // Invalid syntax propagates as an error, zero matches return zero -- no silent rewrites.
  // --where applies inside the candidate query (a post-filter over the top-N would drop
  // matches ranked past the pool) and again on the final select for link-derived rows.
  const whereJoin = opts.where ? `JOIN frontmatter f ON f."path" = content.path` : '';
  const whereCond = opts.where ? `AND (${opts.where})` : '';
  const matchSql = `SELECT content.path AS path, snippet(content, -1, '«', '»', '…', 10) AS hit FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ORDER BY ${WEIGHTED_BM25} LIMIT ${fetch}`;
  const matchRows = db.prepare(matchSql).all(terms) as Array<{ path: string; hit: string }>;

  const hits = new Map(matchRows.map((r) => [r.path, r.hit]));
  const candidates = new Map<string, { score: number; via: string }>();
  matchRows.forEach((r, i) => {
    candidates.set(r.path, { score: 1 / (RRF_K + i), via: 'match' });
  });

  if (featureEnabled(cfg, 'links') && matchRows.length > 0) {
    const nodes = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
    const seeds = new Map(matchRows.map((r, i) => [r.path, 1 / (i + 1)]));
    const ranked = [...personalizedRank(nodes, linkEdges(db), seeds)]
      .filter(([, score]) => score > 1e-9)
      .sort((a, b) => b[1] - a[1])
      .slice(0, fetch);
    ranked.forEach(([path], i) => {
      const existing = candidates.get(path);
      if (existing) {
        existing.score += 1 / (RRF_K + i);
        existing.via = 'match+link';
      } else {
        candidates.set(path, { score: 1 / (RRF_K + i), via: 'link' });
      }
    });
  }

  // Vector expansion, invoked only: a third RRF list at the swept flat-region constants
  // (weight 1, pool = fetch). Each row carries its best chunk's line range.
  const chunkLines = new Map<string, string>();
  if (opts.semantic) {
    const vec = await semanticCandidates(db, cfg, terms, fetch);
    vec.forEach(({ path, lines }, i) => {
      chunkLines.set(path, lines);
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
  db.exec('CREATE TEMP TABLE _find ("path" TEXT PRIMARY KEY, score REAL, via TEXT, hit TEXT, lines TEXT)');
  const insert = db.prepare('INSERT INTO _find ("path", score, via, hit, lines) VALUES (?, ?, ?, ?, ?)');
  for (const [path, c] of candidates) insert.run(path, c.score, c.via, hits.get(path) ?? null, chunkLines.get(path) ?? null);

  const where = opts.where ? `WHERE ${opts.where}` : '';
  const linesCol = opts.semantic ? ', _find.lines' : '';
  return db
    .prepare(
      `SELECT f."path" AS path, content.title, content.summary, _find.hit, _find.via, round(_find.score, 4) AS score${linesCol}
       FROM _find JOIN frontmatter f ON f."path" = _find."path" JOIN content ON content.path = _find."path"
       ${where} ORDER BY _find.score DESC LIMIT ?`
    )
    .all(k) as Row[];
}

export interface TreeMap {
  docs: { count: number; bytes: number };
  fields: Row[]; // top 20 by coverage; fieldsTotal carries the real count
  fieldsTotal: number;
  hubs: Row[];
  recent: Row[];
}

const INTERNAL_COLUMNS = new Set(['path', '_mtime', '_size', '_rank']);

// Layer 0: what is this tree. Fixed-size output regardless of tree size.
export function mapTree(db: DatabaseSync, cfg: Config): TreeMap {
  const docs = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM("_size"), 0) AS bytes FROM frontmatter').get() as { count: number; bytes: number };

  const columns = (db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>).map((r) => r.name).filter((name) => !INTERNAL_COLUMNS.has(name));
  const allFields = columns
    .map((name) => {
      const { n } = db.prepare(`SELECT COUNT("${name.split('"').join('""')}") AS n FROM frontmatter`).get() as { n: number };
      return { field: name, coverage: n };
    })
    .sort((a, b) => (b.coverage as number) - (a.coverage as number)) as Row[];
  const fields = allFields.slice(0, 20);

  const hubs = featureEnabled(cfg, 'rank') ? (db.prepare(`SELECT f."path" AS path, round(f."_rank" * 100, 2) AS rank, content.title FROM frontmatter f JOIN content ON content.path = f."path" WHERE f."_rank" IS NOT NULL ORDER BY f."_rank" DESC LIMIT 8`).all() as Row[]) : [];

  const recent = db.prepare(`SELECT "path", datetime("_mtime" / 1000, 'unixepoch') AS modified FROM frontmatter ORDER BY "_mtime" DESC LIMIT 5`).all() as Row[];

  return { docs, fields, fieldsTotal: allFields.length, hubs, recent };
}

export interface Peek {
  path: string;
  tokens: number;
  frontmatter: Row;
  sections: Row[];
  outbound: string[];
  backlinks: string[];
  unresolved: string[];
  // Totals before truncation: a hub can have thousands of backlinks, and peek's whole
  // point is bounded output. Query the links table directly for the full list.
  outboundTotal: number;
  backlinksTotal: number;
  unresolvedTotal: number;
}

const PEEK_LINK_LIMIT = 20;

// Layer 2: everything about one note except its prose -- frontmatter, outline with line
// ranges + token estimates (so the follow-up Read is a range, not the file), links both ways.
export function peek(db: DatabaseSync, cfg: Config, pathArg: string): Peek {
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

  const sections = featureEnabled(cfg, 'sections') ? (db.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx').all(path) as Row[]) : [];

  let outbound: string[] = [];
  let backlinks: string[] = [];
  let unresolved: string[] = [];
  let backlinksTotal = 0;
  if (featureEnabled(cfg, 'links')) {
    const out = db.prepare('SELECT target, dst FROM links WHERE src = ? ORDER BY target').all(path) as Array<{ target: string; dst: string | null }>;
    outbound = [...new Set(out.filter((l) => l.dst !== null).map((l) => l.dst as string))];
    unresolved = out.filter((l) => l.dst === null).map((l) => l.target);
    backlinksTotal = (db.prepare('SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = ?').get(path) as { n: number }).n;
    backlinks = (db.prepare('SELECT DISTINCT src FROM links WHERE dst = ? ORDER BY src LIMIT ?').all(path, PEEK_LINK_LIMIT) as Array<{ src: string }>).map((r) => r.src);
  }

  return {
    path,
    tokens: Math.ceil(((row._size as number) ?? 0) / 4),
    frontmatter,
    sections,
    outbound: outbound.slice(0, PEEK_LINK_LIMIT),
    backlinks,
    unresolved: unresolved.slice(0, PEEK_LINK_LIMIT),
    outboundTotal: outbound.length,
    backlinksTotal,
    unresolvedTotal: unresolved.length,
  };
}
