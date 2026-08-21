import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { FileStat } from '../scan.ts';
import type { Feature, ReconcileDelta } from './types.ts';

// links(src, target, target_base, dst): target as written, target_base its baseKey
// (indexed, for the incremental resolve below), dst the resolved path or NULL (a
// queryable dead link).

// Wikilinks ([[target]], [[target#anchor|alias]], embeds) plus relative markdown links to .md files.
function extract(_raw: string, body: string): string[] {
  const targets = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const target = m[1].trim();
    if (target) targets.add(target);
  }
  for (const m of body.matchAll(/\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
    const target = m[1].trim();
    if (target && !/^[a-z]+:\/\//i.test(target)) targets.add(target);
  }
  return [...targets];
}

function cleanTarget(target: string): string {
  return target.replace(/\\/g, '/').replace(/^\.\//, '');
}

function baseKey(path: string): string {
  return posix.basename(path).replace(/\.md$/i, '').toLowerCase();
}

// Obsidian-style: exact relative path (with/without .md), path relative to the linking
// note's directory, then basename match (lexicographically first on ties).
function resolveTarget(src: string, target: string, pathSet: Set<string>, byBase: Map<string, string[]>): string | null {
  const clean = cleanTarget(target);
  const fromSrc = posix.normalize(posix.join(posix.dirname(src), clean));
  for (const candidate of [clean, `${clean}.md`, fromSrc, `${fromSrc}.md`]) {
    if (pathSet.has(candidate)) return candidate;
  }
  return byBase.get(baseKey(clean))?.[0] ?? null;
}

function buildByBase(files: FileStat[]): Map<string, string[]> {
  const byBase = new Map<string, string[]>();
  for (const path of files.map((f) => f.relPath).sort()) {
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
}

// Applies resolveTarget to `rows`, writing only rows whose dst actually changes.
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
  const rows = db.prepare('SELECT src, target, dst FROM links').all() as unknown as LinkRow[];
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
    for (const row of rows) candidates.set(`${row.src}\0${row.target}`, row);
  };
  // Chunked so a large-but-under-threshold delta never exceeds SQLite's bound-variable
  // limit (SQLITE_MAX_VARIABLE_NUMBER, 32766).
  const collectIn = (column: string, keys: string[]) => {
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      collect(db.prepare(`SELECT src, target, dst FROM links WHERE ${column} IN (${placeholders})`).all(...chunk) as unknown as LinkRow[]);
    }
  };

  collectIn('src', delta.reparsed);
  collectIn('target_base', [...changedBasenames]);
  collectIn('dst', delta.vanished);

  return resolveRows(db, [...candidates.values()], pathSet, byBase);
}

// Resolved edges, for rank and for search's graph expansion.
export function linkEdges(db: DatabaseSync): [string, string][] {
  return (db.prepare('SELECT src, dst FROM links WHERE dst IS NOT NULL').all() as Array<{ src: string; dst: string }>).map((r) => [r.src, r.dst]);
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
    db.exec('CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT, target_base TEXT, dst TEXT, PRIMARY KEY (src, target))');
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
    const targets = extracted as string[];
    // Stale rows (targets the new parse no longer contains) are real edge removals.
    let stale: ReturnType<ReturnType<DatabaseSync['prepare']>['run']>;
    if (targets.length === 0) {
      stale = db.prepare('DELETE FROM links WHERE src = ?').run(path);
    } else {
      const placeholders = targets.map(() => '?').join(', ');
      stale = db.prepare(`DELETE FROM links WHERE src = ? AND target NOT IN (${placeholders})`).run(path, ...targets);
    }
    if (Number(stale.changes) > 0) recordRemoved(delta, path);
    // Upsert preserves dst on surviving rows, so an unchanged link resolves to the same
    // value and reports no change; only genuinely new rows start at NULL.
    const insert = db.prepare('INSERT INTO links (src, target, target_base, dst) VALUES (?, ?, ?, NULL) ON CONFLICT(src, target) DO UPDATE SET target_base = excluded.target_base');
    for (const target of targets) insert.run(path, target, baseKey(cleanTarget(target)));
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
