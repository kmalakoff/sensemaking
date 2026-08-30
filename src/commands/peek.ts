import posix from 'node:path/posix';
import { estimateTokens } from '../chunk/index.ts';
import type { FeatureName, ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { featureEnabled } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Row } from '../output/output.ts';
import type { Store } from '../store/types.ts';
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
  // headings), and peek's whole point is bounded output.
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
export async function peek(store: Store, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides = {}): Promise<Peek> {
  return store.transaction(async () => {
    const pathsStmt = await store.prepare('SELECT "path" FROM frontmatter');
    const paths = ((await pathsStmt.all()) as Array<{ path: string }>).map((r) => r.path);
    const path = resolveNote(paths, pathArg);

    const rowStmt = await store.prepare('SELECT * FROM frontmatter WHERE "path" = ?');
    const row = (await rowStmt.get(path)) as Row;
    const parseError = (row._parse_error as string | null) ?? null;
    const frontmatter: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (!INTERNAL_COLUMNS.has(key) && value !== null) frontmatter[key] = value;
    }

    let sectionsTotal = 0;
    let sections: Row[] = [];
    if (featureEnabled(cfg, 'sections')) {
      sectionsTotal = ((await (await store.prepare('SELECT COUNT(*) AS n FROM sections WHERE "path" = ?')).get(path)) as { n: number }).n;
      sections = (await (await store.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx LIMIT ?')).all(path, PEEK_LIST_LIMIT)) as Row[];
    }

    let outbound: string[] = [];
    let backlinks: string[] = [];
    let unresolved: string[] = [];
    let backlinksTotal = 0;
    await scopedPaths(store, cfg, overrides); // validates --preset/--where/--include/--exclude even though peek's own output isn't scope-filtered
    if (featureEnabled(cfg, 'links')) {
      const out = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ? AND (dst IS NULL OR dst != src) ORDER BY target')).all(path)) as Array<{ target: string; dst: string | null }>;
      outbound = [...new Set(out.filter((l) => l.dst !== null).map((l) => l.dst as string))];
      unresolved = out.filter((l) => l.dst === null).map((l) => l.target);
      backlinksTotal = ((await (await store.prepare('SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = ? AND src != dst')).get(path)) as { n: number }).n;
      backlinks = ((await (await store.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst ORDER BY src LIMIT ?')).all(path, PEEK_LIST_LIMIT)) as Array<{ src: string }>).map((r) => r.src);
    }

    // content.text is the stripped body already computed at reconcile time (no extra file read),
    // floored by the byte/4 estimate so stripped-away syntax and frontmatter can't vanish from the price.
    const body = ((await (await store.prepare('SELECT text FROM content WHERE "path" = ?')).get(path)) as { text: string } | undefined)?.text;
    const byteTokens = Math.ceil(((row._size as number) ?? 0) / 4);
    const tokens = body !== undefined ? Math.max(Math.ceil(estimateTokens(body)), byteTokens) : byteTokens;

    return {
      path,
      tokens,
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
  });
}
