// Frontier-by-frontier BFS through a temp visited table, one indexed anti-join per ring: a
// local question touches a neighborhood, never the whole edge list.
import type { Store } from '../store/types.ts';

type Direction = 'forward' | 'reverse' | 'both';

interface FindPathOptions {
  directed?: boolean;
  maxDepth?: number;
  allowed?: Set<string>;
}

async function resetVisited(store: Store): Promise<void> {
  await store.exec('DROP TABLE IF EXISTS temp.visited');
  await store.exec('CREATE TEMP TABLE visited (path TEXT PRIMARY KEY, depth INTEGER NOT NULL, pred TEXT)');
}

// Materializes the caller-resolved scope Set into a temp table so it joins like any other
// indexed column. `extra`, when given, is always in scope -- findPath's `to` endpoint.
async function setupAllowed(store: Store, allowed: Set<string>, extra?: string): Promise<void> {
  const all = new Set(allowed);
  if (extra !== undefined) all.add(extra);
  await store.exec('DROP TABLE IF EXISTS temp.allowed_nodes');
  await store.exec('CREATE TEMP TABLE allowed_nodes (path TEXT PRIMARY KEY)');
  await store.runBatch(
    'INSERT INTO allowed_nodes (path) VALUES (?)',
    [...all].map((p) => [p])
  );
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
// everything already visited, optionally filtered to the allowed set, inserted at the new depth (?2); RETURNING gives what this ring newly reached.
function ringSql(direction: Direction, hasAllowed: boolean): string {
  return `
INSERT INTO visited (path, depth, pred)
SELECT cand.path, ?2, MIN(cand.pred)
FROM (${candidateSelect(direction)}) cand
WHERE NOT EXISTS (SELECT 1 FROM visited v2 WHERE v2.path = cand.path)
${hasAllowed ? 'AND EXISTS (SELECT 1 FROM allowed_nodes a WHERE a.path = cand.path)' : ''}
GROUP BY cand.path
ORDER BY cand.path
RETURNING path`;
}

async function reconstructPath(store: Store, to: string): Promise<string[]> {
  const lookup = await store.prepare('SELECT pred FROM visited WHERE path = ?');
  const path: string[] = [];
  let cur: string | null = to;
  while (cur !== null) {
    path.push(cur);
    const row = (await lookup.get(cur)) as { pred: string | null } | undefined;
    cur = row ? row.pred : null;
  }
  return path.reverse();
}

// One BFS from `from`, tracking a predecessor per node. Undirected by default, matching
// personalizedRank; null when `to` is unreached within `maxDepth`.
export async function findPath(store: Store, from: string, to: string, opts: FindPathOptions = {}): Promise<string[] | null> {
  if (from === to) return [from];

  const direction: Direction = opts.directed ? 'forward' : 'both';
  const maxDepth = opts.maxDepth ?? Infinity;
  if (maxDepth <= 0) return null;

  await resetVisited(store);
  const insertStart = await store.prepare('INSERT INTO visited (path, depth, pred) VALUES (?, 0, NULL)');
  await insertStart.run(from);
  if (opts.allowed) await setupAllowed(store, opts.allowed, to);

  const stmt = await store.prepare(ringSql(direction, !!opts.allowed));
  for (let ring = 1; ring <= maxDepth; ring++) {
    const rows = (await stmt.all(ring - 1, ring)) as Array<{ path: string }>;
    if (rows.length === 0) break;
    if (rows.some((row) => row.path === to)) return reconstructPath(store, to);
  }
  return null;
}
