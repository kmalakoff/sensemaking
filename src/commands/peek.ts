import posix from 'node:path/posix';
import { estimateTokens } from '../chunk/index.ts';
import type { FeatureName, ResolvedConfig, SearchOverrides } from '../config/index.ts';
import { featureEnabled } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { serialQuery } from '../lib/serial-query.ts';
import type { Row } from '../output/output.ts';
import type { Store } from '../store/types.ts';
import { INTERNAL_COLUMNS, materializeScope, scopedPaths } from './scope.ts';
import { assertQuerySnapshot } from './snapshot.ts';

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

/** Structured, bounded metadata returned by the root {@link peek} API. */
export interface Peek {
  path: string;
  tokens: number;
  frontmatter: Row;
  /** Set when frontmatter parsing failed, distinguishing that case from an empty block. */
  parseError: string | null;
  sections: PeekSection[];
  outbound: string[];
  backlinks: string[];
  unresolved: string[];
  /** Totals before each bounded list is truncated. */
  sectionsTotal: number;
  outboundTotal: number;
  backlinksTotal: number;
  unresolvedTotal: number;
  /** Disabled features whose result blocks are omitted rather than returned empty. */
  off: FeatureName[];
}

export interface PeekSection {
  level: number;
  heading: string;
  start_line: number;
  end_line: number;
  tokens: number;
}

const PEEK_LIST_LIMIT = 20;

/**
 * Returns indexed metadata for a note in scope. Exact excluded paths fail before scoped basename
 * resolution; resolved neighbors stay in scope, while unresolved written targets remain visible.
 */
export function peek(store: Store, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides = {}): Promise<Peek> {
  return serialQuery(store, () => peekIndexed(store, cfg, pathArg, overrides));
}

async function peekIndexed(store: Store, cfg: ResolvedConfig, pathArg: string, overrides: SearchOverrides): Promise<Peek> {
  return store.transaction(async () => {
    await assertQuerySnapshot(store, cfg);
    const pathsStmt = await store.prepare('SELECT "path" FROM frontmatter');
    const paths = ((await pathsStmt.all()) as Array<{ path: string }>).map((r) => r.path);
    const allowed = await scopedPaths(store, cfg, overrides);
    if (paths.includes(pathArg) && !allowed.has(pathArg)) {
      throw new SenseError('NOTE_NOT_FOUND', `note "${pathArg}" exists but is outside the current scope; change the preset, include/exclude patterns, or where condition`);
    }
    let path: string;
    try {
      path = resolveNote([...allowed], pathArg);
    } catch (err) {
      if (err instanceof SenseError && err.code === 'NOTE_NOT_FOUND') {
        let excludedPath: string;
        try {
          excludedPath = resolveNote(paths, pathArg);
        } catch (unscopedErr) {
          if (unscopedErr instanceof SenseError && unscopedErr.code === 'NOTE_AMBIGUOUS') {
            throw new SenseError('NOTE_NOT_FOUND', `no note in the current scope matches "${pathArg}"; indexed matches exist outside the scope, so change the preset, include/exclude patterns, or where condition`);
          }
          throw err;
        }
        throw new SenseError('NOTE_NOT_FOUND', `note "${excludedPath}" exists but is outside the current scope; change the preset, include/exclude patterns, or where condition`);
      }
      throw err;
    }

    const rowStmt = await store.prepare('SELECT * FROM frontmatter WHERE "path" = ?');
    const row = (await rowStmt.get(path)) as Row;
    const parseError = (row._parse_error as string | null) ?? null;
    const frontmatter: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (!INTERNAL_COLUMNS.has(key) && value !== null) frontmatter[key] = value;
    }

    let sectionsTotal = 0;
    let sections: PeekSection[] = [];
    if (featureEnabled(cfg, 'sections')) {
      sectionsTotal = ((await (await store.prepare('SELECT COUNT(*) AS n FROM sections WHERE "path" = ?')).get(path)) as { n: number }).n;
      sections = (await (await store.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx LIMIT ?')).all(path, PEEK_LIST_LIMIT)) as PeekSection[];
    }

    let outbound: string[] = [];
    let backlinks: string[] = [];
    let unresolved: string[] = [];
    let backlinksTotal = 0;
    if (featureEnabled(cfg, 'links')) {
      await materializeScope(store, '_peek_scope', allowed);
      const out = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ? AND (dst IS NULL OR (dst != src AND dst IN (SELECT "path" FROM _peek_scope))) ORDER BY target')).all(path)) as Array<{ target: string; dst: string | null }>;
      outbound = [...new Set(out.filter((l): l is { target: string; dst: string } => l.dst !== null).map((l) => l.dst))];
      unresolved = out.filter((l) => l.dst === null).map((l) => l.target);
      backlinksTotal = ((await (await store.prepare('SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = ? AND src != dst AND src IN (SELECT "path" FROM _peek_scope)')).get(path)) as { n: number }).n;
      backlinks = ((await (await store.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst AND src IN (SELECT "path" FROM _peek_scope) ORDER BY src LIMIT ?')).all(path, PEEK_LIST_LIMIT)) as Array<{ src: string }>).map((r) => r.src);
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
