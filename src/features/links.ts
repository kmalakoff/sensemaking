import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import { maskRegions } from '../fences.ts';
import type { FileStat } from '../scan.ts';
import type { Feature, ReconcileDelta } from './types.ts';

// links(src, target, target_base, dst, embed): target as written, target_base its baseKey
// (indexed, for the incremental resolve below), dst the resolved path or NULL (a
// queryable dead link), embed whether it's `![[x]]`/`![](x.md)` rather than `[[x]]`/`[](x.md)`
// -- Obsidian's grain: a target both linked and embedded in the same note is two rows.

// Wikilinks ([[target]], [[target#anchor|alias]], embeds), internal markdown links, and
// frontmatter values that are exactly a wikilink ("[[X]]"; mid-string and ![[...]] forms are
// not links there -- Obsidian's rule, probe-verified).
function extract(_raw: string, rawBody: string, _search?: { title: string; summary: string }, data?: Record<string, unknown>): Array<{ target: string; embed: boolean }> {
  const body = /\[\[|\]\(/.test(rawBody) ? maskRegions(rawBody) : rawBody;
  const seen = new Set<string>();
  const results: Array<{ target: string; embed: boolean }> = [];
  const add = (target: string, embed: boolean) => {
    const key = `${target}\0${embed ? '1' : '0'}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ target, embed });
  };
  // To the first ]], as Obsidian parses it, so a heading or alias holding a lone ] still
  // matches; anchor and alias split off in code, since a class-based regex stops at the ].
  for (const m of body.matchAll(/\[\[(.*?)\]\]/g)) {
    const embed = body[(m.index ?? 0) - 1] === '!';
    // [[#Heading]]: a same-note anchor link, which Obsidian resolves to a self-edge. Keep the
    // target as written (leading #) so resolveTarget can special-case it.
    const beforeAlias = m[1].split('|')[0].trim();
    if (beforeAlias.startsWith('#')) {
      if (beforeAlias.length > 1) add(beforeAlias, embed);
      continue;
    }
    const target = beforeAlias.split('#')[0].trim();
    if (target) add(target, embed);
  }
  // Any internal destination, not only .md-suffixed: Obsidian gives markdown links full
  // linkpath resolution, so \](Zektor) resolves like [[Zektor]] and \](#anchor) is a
  // self-edge. External URLs (a scheme anywhere survives the malformed double-paren case)
  // and titled links (dest stops at whitespace) are skipped.
  // A space in the destination is only valid ahead of a quoted title; a domain-shaped first
  // segment (www.example.com/...) is external even without a scheme.
  for (const m of body.matchAll(/(!)?\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^)]*"|'[^)]*'))?\)/g)) {
    const dest = m[2].trim();
    if (!dest || dest.includes('://')) continue;
    if (/^www\./i.test(dest)) continue;
    const target = dest.startsWith('#') ? dest : dest.split('#')[0];
    if (target) add(target, m[1] === '!');
  }
  for (const value of Object.values(data ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item !== 'string') continue;
      const m = /^\[\[(.*)\]\]$/.exec(item.trim());
      if (!m) continue;
      const inner = m[1].split('|')[0].trim();
      const target = inner.split('#')[0].trim();
      if (target) add(target, false);
      else if (inner.startsWith('#') && inner.length > 1) add(inner, false);
    }
  }
  return results;
}

function cleanTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function baseKey(path: string): string {
  return posix.basename(path).replace(/\.md$/i, '').toLowerCase();
}

// Obsidian-style: exact relative path (with/without .md), path relative to the linking
// note's directory, then basename match (shortest path wins on ties -- verified against a
// cold-loaded Obsidian vault on 6+ real collision pairs; byBase's lists are pre-sorted that way).
function resolveTarget(src: string, target: string, pathSet: Set<string>, byBase: Map<string, string[]>): string | null {
  // [[#Heading]]: a same-note anchor, always the note itself -- never depends on other files.
  if (target.startsWith('#')) return src;
  const clean = cleanTarget(target);
  const fromSrc = posix.normalize(posix.join(posix.dirname(src), clean));
  for (const candidate of [clean, `${clean}.md`, fromSrc, `${fromSrc}.md`]) {
    if (pathSet.has(candidate)) return candidate;
  }
  const candidates = byBase.get(baseKey(clean));
  if (!candidates) return null;
  // The linking note itself wins a basename collision (Obsidian resolves to self before the
  // shortest-path rule -- cold-load verified on the hub corpus).
  return candidates.includes(src) ? src : candidates[0];
}

// Shortest path wins a basename collision; equal lengths fall back to lexicographic, our own
// deterministic tiebreak for a case Obsidian itself leaves registration-order-dependent.
function buildByBase(files: FileStat[]): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  const paths = files.map((f) => f.relPath).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  for (const path of paths) {
    const key = baseKey(path);
    const list = byBase.get(key);
    if (list) list.push(path);
    else byBase.set(key, [path]);
  }
  return byBase;
}

interface LinkRow {
  src: string;
  target: string;
  dst: string | null;
  embed: number;
}

// Applies resolveTarget to `rows`, writing only rows whose dst actually changes. The UPDATE
// keys on (src, target): a link/embed sibling pair shares one resolution, so either row's
// mismatch rewrites both.
function resolveRows(db: DatabaseSync, rows: LinkRow[], pathSet: Set<string>, byBase: Map<string, string[]>): boolean {
  const update = db.prepare('UPDATE links SET dst = ? WHERE src = ? AND target = ?');
  let changed = false;
  for (const row of rows) {
    const dst = resolveTarget(row.src, row.target, pathSet, byBase);
    if (dst !== row.dst) {
      update.run(dst, row.src, row.target);
      changed = true;
    }
  }
  return changed;
}

// A new or deleted file can change any note's resolution, so re-resolve the whole table.
// Fallback for cold builds and large deltas -- see afterReconcile's threshold.
function resolveAll(db: DatabaseSync, files: FileStat[]): boolean {
  const pathSet = new Set(files.map((f) => f.relPath));
  const byBase = buildByBase(files);
  const rows = db.prepare('SELECT src, target, dst, embed FROM links').all() as unknown as LinkRow[];
  return resolveRows(db, rows, pathSet, byBase);
}

// Re-resolve only what this reconcile could have touched: re-stored sources, links whose
// target basename matches an added/vanished file, and links whose dst just vanished. All
// three are indexed lookups, so this never reads the whole table.
function resolveIncremental(db: DatabaseSync, delta: ReconcileDelta): boolean {
  const pathSet = new Set(delta.files.map((f) => f.relPath));
  const byBase = buildByBase(delta.files);

  const changedBasenames = new Set<string>();
  for (const p of delta.added) changedBasenames.add(baseKey(p));
  for (const p of delta.vanished) changedBasenames.add(baseKey(p));

  // \0 can't appear in a path or target, so the key never collides; a space can.
  const candidates = new Map<string, LinkRow>();
  const collect = (rows: LinkRow[]) => {
    for (const row of rows) candidates.set(`${row.src}\0${row.target}\0${row.embed}`, row);
  };
  // Chunked so a large-but-under-threshold delta never exceeds SQLite's bound-variable
  // limit (SQLITE_MAX_VARIABLE_NUMBER, 32766).
  const collectIn = (column: string, keys: string[]) => {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      collect(db.prepare(`SELECT src, target, dst, embed FROM links WHERE ${column} IN (${placeholders})`).all(...chunk) as unknown as LinkRow[]);
    }
  };

  collectIn('src', delta.reparsed);
  collectIn('target_base', [...changedBasenames]);
  collectIn('dst', delta.vanished);

  return resolveRows(db, [...candidates.values()], pathSet, byBase);
}

// Resolved edges, for rank and for search's graph expansion.
export function linkEdges(db: DatabaseSync): [string, string][] {
  // One edge per row, as 0.12's grain always had it -- two written targets resolving to one
  // dst stay two edges (a weight the fusion evals were gated on). The only exclusion is an
  // embed whose exact (src, target) also exists as a link: that second row is new with the
  // embed grain and would double an edge that used to be one row. The NOT EXISTS probes the
  // primary key and fires only for embed rows; both branches still scan the table.
  // Self-edges (same-note anchors) are excluded here so PageRank mass is not self-recycled --
  // Obsidian's own graph view hides self-loops too. The rows themselves stay in the table for
  // backlinks/peek.
  const sql = `SELECT src, dst FROM links WHERE dst IS NOT NULL AND embed = 0 AND src != dst
    UNION ALL
    SELECT src, dst FROM links l WHERE dst IS NOT NULL AND embed = 1 AND src != dst
      AND NOT EXISTS (SELECT 1 FROM links l0 WHERE l0.src = l.src AND l0.target = l.target AND l0.embed = 0)`;
  return (db.prepare(sql).all() as Array<{ src: string; dst: string }>).map((r) => [r.src, r.dst]);
}

// remove() has already deleted the rows by the time afterReconcile runs, so it records here
// whether they carried edges. Keyed on the delta object, so the state dies with the reconcile.
const removedWithLinks = new WeakMap<ReconcileDelta, Set<string>>();

function recordRemoved(delta: ReconcileDelta, path: string): void {
  let set = removedWithLinks.get(delta);
  if (!set) {
    set = new Set();
    removedWithLinks.set(delta, set);
  }
  set.add(path);
}

// remove() runs per path; the vanished list is an array, so cache the Set per delta.
const vanishedSets = new WeakMap<ReconcileDelta, Set<string>>();
function vanishedSet(delta: ReconcileDelta): Set<string> {
  let set = vanishedSets.get(delta);
  if (!set) {
    set = new Set(delta.vanished);
    vanishedSets.set(delta, set);
  }
  return set;
}

export const links: Feature = {
  name: 'links',
  schema(db) {
    db.exec('CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT, target_base TEXT, dst TEXT, embed INTEGER, PRIMARY KEY (src, target, embed))');
    db.exec('CREATE INDEX IF NOT EXISTS links_dst ON links(dst)');
    db.exec('CREATE INDEX IF NOT EXISTS links_target_base ON links(target_base)');
  },
  extract,
  // Reparsed docs are diffed in store() below instead of wiped here: deleting and
  // re-inserting resets dst to NULL, which made every touch-only reparse read as an edge
  // change and recompute PageRank -- measured as most of the remaining update cost.
  remove(db, path, delta) {
    if (!vanishedSet(delta).has(path)) return;
    const result = db.prepare('DELETE FROM links WHERE src = ?').run(path);
    if (Number(result.changes) > 0) recordRemoved(delta, path);
  },
  store(db, path, extracted, delta) {
    const targets = extracted as Array<{ target: string; embed: boolean }>;
    // Stale rows (target/embed pairs the new parse no longer contains) are real edge removals.
    // \0 can't appear in a target, so the composite key never collides.
    let stale: ReturnType<ReturnType<DatabaseSync['prepare']>['run']>;
    if (targets.length === 0) {
      stale = db.prepare('DELETE FROM links WHERE src = ?').run(path);
    } else {
      const placeholders = targets.map(() => '?').join(', ');
      const keys = targets.map((t) => `${t.target}\0${t.embed ? '1' : '0'}`);
      stale = db.prepare(`DELETE FROM links WHERE src = ? AND (target || char(0) || embed) NOT IN (${placeholders})`).run(path, ...keys);
    }
    if (Number(stale.changes) > 0) recordRemoved(delta, path);
    // Upsert preserves dst on surviving rows, so an unchanged link resolves to the same
    // value and reports no change; only genuinely new rows start at NULL.
    const insert = db.prepare('INSERT INTO links (src, target, target_base, dst, embed) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(src, target, embed) DO UPDATE SET target_base = excluded.target_base');
    // A same-note anchor's dst is always its own src, never another file's basename, so it
    // gets no target_base -- SQL's `IN` never matches NULL, keeping it out of
    // resolveIncremental's cross-file collectIn('target_base', ...) entirely.
    for (const { target, embed } of targets) insert.run(path, target, target.startsWith('#') ? null : baseKey(cleanTarget(target)), embed ? 1 : 0);
  },
  afterReconcile(db, delta) {
    // Any deleted rows that carried edges mean the edge set shrank -- whether the file
    // vanished or was reparsed down to fewer/no links. dstChanged alone misses the
    // reparsed-to-zero-links case (no surviving rows to re-resolve).
    const removeHadLinks = (removedWithLinks.get(delta)?.size ?? 0) > 0;

    const churn = delta.reparsed.length + delta.vanished.length;
    // Past this share of the tree, a full pass is the only one guaranteed to match
    // resolveTarget's ambiguity rules. A cold build clears the threshold on its own.
    const large = delta.files.length === 0 || churn > 0.2 * delta.files.length;

    const dstChanged = large ? resolveAll(db, delta.files) : resolveIncremental(db, delta);
    delta.linksChanged = dstChanged || removeHadLinks;
  },
};
