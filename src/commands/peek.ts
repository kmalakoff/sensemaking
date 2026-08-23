import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName, ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { featureEnabled } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Row } from '../output.ts';
import { INTERNAL_COLUMNS, scopedPaths } from './scope.ts';

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
