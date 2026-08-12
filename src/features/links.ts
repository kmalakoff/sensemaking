import posix from 'node:path/posix';
import type { DatabaseSync } from 'node:sqlite';
import type { FileStat } from '../scan.ts';
import type { Feature } from './types.ts';

// links(src, target, dst): target as written, dst the resolved path or NULL (a queryable dead link).

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

function baseKey(path: string): string {
  return posix.basename(path).replace(/\.md$/i, '').toLowerCase();
}

// Obsidian-style: exact relative path (with/without .md), path relative to the linking
// note's directory, then basename match (lexicographically first on ties).
function resolveTarget(src: string, target: string, pathSet: Set<string>, byBase: Map<string, string[]>): string | null {
  const clean = target.replace(/\\/g, '/').replace(/^\.\//, '');
  const fromSrc = posix.normalize(posix.join(posix.dirname(src), clean));
  for (const candidate of [clean, `${clean}.md`, fromSrc, `${fromSrc}.md`]) {
    if (pathSet.has(candidate)) return candidate;
  }
  return byBase.get(baseKey(clean))?.[0] ?? null;
}

// A new or deleted file can change any note's resolution, so re-resolve the whole table
// whenever the vault changes. An in-memory probe per row; writes only on change.
function resolveAll(db: DatabaseSync, files: FileStat[]): void {
  const pathSet = new Set(files.map((f) => f.relPath));
  const byBase = new Map<string, string[]>();
  for (const path of [...pathSet].sort()) {
    const list = byBase.get(baseKey(path));
    if (list) list.push(path);
    else byBase.set(baseKey(path), [path]);
  }
  const rows = db.prepare('SELECT src, target, dst FROM links').all() as Array<{ src: string; target: string; dst: string | null }>;
  const update = db.prepare('UPDATE links SET dst = ? WHERE src = ? AND target = ?');
  for (const row of rows) {
    const dst = resolveTarget(row.src, row.target, pathSet, byBase);
    if (dst !== row.dst) update.run(dst, row.src, row.target);
  }
}

// Resolved edges, for rank and for find's graph expansion.
export function linkEdges(db: DatabaseSync): [string, string][] {
  return (db.prepare('SELECT src, dst FROM links WHERE dst IS NOT NULL').all() as Array<{ src: string; dst: string }>).map((r) => [r.src, r.dst]);
}

export const links: Feature = {
  name: 'links',
  schema(db) {
    db.exec('CREATE TABLE IF NOT EXISTS links (src TEXT, target TEXT, dst TEXT, PRIMARY KEY (src, target))');
    db.exec('CREATE INDEX IF NOT EXISTS links_dst ON links(dst)');
  },
  extract,
  remove(db, path) {
    db.prepare('DELETE FROM links WHERE src = ?').run(path);
  },
  store(db, path, extracted) {
    const insert = db.prepare('INSERT OR REPLACE INTO links (src, target, dst) VALUES (?, ?, NULL)');
    for (const target of extracted as string[]) insert.run(path, target);
  },
  afterReconcile: resolveAll,
};
