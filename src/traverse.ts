// Frontier-by-frontier BFS through a temp visited table, one indexed anti-join per ring: a
// local question touches a neighborhood, never the whole edge list.
import type { DatabaseSync } from 'node:sqlite';

type Direction = 'forward' | 'reverse' | 'both';

interface FindPathOptions {
  directed?: boolean;
  maxDepth?: number;
  allowed?: Set<string>;
}

function resetVisited(db: DatabaseSync): void {
  db.exec('DROP TABLE IF EXISTS temp.visited');
  db.exec('CREATE TEMP TABLE visited (path TEXT PRIMARY KEY, depth INTEGER NOT NULL, pred TEXT)');
}

// Materializes the caller-resolved scope Set into a temp table so it joins like any other
// indexed column. `extra`, when given, is always in scope -- findPath's `to` endpoint.
function setupAllowed(db: DatabaseSync, allowed: Set<string>, extra?: string): void {
  db.exec('DROP TABLE IF EXISTS temp.allowed_nodes');
  db.exec('CREATE TEMP TABLE allowed_nodes (path TEXT PRIMARY KEY)');
  db.prepare('INSERT INTO allowed_nodes SELECT DISTINCT value FROM json_each(?1)').run(JSON.stringify([...allowed]));
  if (extra !== undefined) db.prepare('INSERT OR IGNORE INTO allowed_nodes VALUES (?)').run(extra);
}

// Only resolved links (dst IS NOT NULL) are followed, in either direction.
function candidateSelect(direction: Direction): string {
  const forward = 'SELECT l.dst AS path, l.src AS pred FROM links l JOIN visited v ON v.path = l.src AND v.depth = ?1 WHERE l.dst IS NOT NULL';
  const reverse = 'SELECT l.src AS path, l.dst AS pred FROM links l JOIN visited v ON v.path = l.dst AND v.depth = ?1 WHERE l.dst IS NOT NULL';
  if (direction === 'forward') return forward;
  if (direction === 'reverse') return reverse;
  return `${forward} UNION ALL ${reverse}`;
}

// One ring: candidates adjacent to the previous ring's frontier (?1), anti-joined against
// everything already visited, optionally filtered to the allowed set, capped (?3) and
// inserted at the new depth (?2). RETURNING hands back exactly what this ring newly reached.
function ringSql(direction: Direction, hasAllowed: boolean): string {
  return `
INSERT INTO visited (path, depth, pred)
SELECT cand.path, ?2, MIN(cand.pred)
FROM (${candidateSelect(direction)}) cand
WHERE NOT EXISTS (SELECT 1 FROM visited v2 WHERE v2.path = cand.path)
${hasAllowed ? 'AND EXISTS (SELECT 1 FROM allowed_nodes a WHERE a.path = cand.path)' : ''}
GROUP BY cand.path
ORDER BY cand.path
LIMIT ?3
RETURNING path`;
}

function reconstructPath(db: DatabaseSync, to: string): string[] {
  const lookup = db.prepare('SELECT pred FROM visited WHERE path = ?');
  const path: string[] = [];
  let cur: string | null = to;
  while (cur !== null) {
    path.push(cur);
    const row = lookup.get(cur) as { pred: string | null } | undefined;
    cur = row ? row.pred : null;
  }
  return path.reverse();
}

// One BFS from `from`, tracking a predecessor per node. Undirected by default, matching
// personalizedRank; null when `to` is unreached within `maxDepth`.
export function findPath(db: DatabaseSync, from: string, to: string, opts: FindPathOptions = {}): string[] | null {
  if (from === to) return [from];

  const direction: Direction = opts.directed ? 'forward' : 'both';
  const maxDepth = opts.maxDepth ?? Infinity;
  if (maxDepth <= 0) return null;

  resetVisited(db);
  db.prepare('INSERT INTO visited (path, depth, pred) VALUES (?, 0, NULL)').run(from);
  if (opts.allowed) setupAllowed(db, opts.allowed, to);

  const stmt = db.prepare(ringSql(direction, !!opts.allowed));
  for (let ring = 1; ring <= maxDepth; ring++) {
    const rows = stmt.all(ring - 1, ring, -1) as Array<{ path: string }>;
    if (rows.length === 0) break;
    if (rows.some((row) => row.path === to)) return reconstructPath(db, to);
  }
  return null;
}
