import { pagerank } from '../graph.ts';
import { linkEdges } from './links.ts';
import type { Feature } from './types.ts';

// frontmatter._rank: PageRank over resolved links -- a static "how load-bearing is this
// note" prior. Depends on links (enforced in config.featureEnabled).

export const rank: Feature = {
  name: 'rank',
  schema(db) {
    const columns = db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === '_rank')) db.exec('ALTER TABLE frontmatter ADD COLUMN "_rank" REAL');
  },
  afterReconcile(db, delta) {
    // links.afterReconcile runs first (registry order) and sets delta.linksChanged;
    // `undefined` (links off, or no opinion) recomputes, same as always -- only an
    // explicit `false` allows a skip. Rank also depends on the node set (every note is a
    // PageRank node, edges or not), so any add or vanish recomputes even with edges
    // untouched -- otherwise a new linkless note keeps _rank NULL and every other rank
    // stays normalized over the old count.
    if (delta.linksChanged === false && delta.added.length === 0 && delta.vanished.length === 0) return;
    const nodes = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
    const ranks = pagerank(nodes, linkEdges(db));
    const update = db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?');
    for (const [path, value] of ranks) update.run(value, path);
  },
};
