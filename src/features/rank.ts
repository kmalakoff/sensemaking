import { pagerank } from '../graph/graph.ts';
import { linkEdges } from './links.ts';
import type { Feature } from './types.ts';

// frontmatter._rank: PageRank over resolved links -- a static "how load-bearing is this
// note" prior. Depends on links (enforced in config.featureEnabled).

export const rank: Feature = {
  name: 'rank',
  async schema(db) {
    const stmt = await db.prepare('PRAGMA table_info(frontmatter)');
    const columns = (await stmt.all()) as Array<{ name: string }>;
    if (!columns.some((c) => c.name === '_rank')) await db.exec('ALTER TABLE frontmatter ADD COLUMN "_rank" REAL');
  },
  async afterReconcile(db, delta) {
    // Only an explicit linksChanged:false skips. Rank also depends on the node set, so any
    // add or vanish recomputes -- otherwise a new linkless note keeps _rank NULL.
    if (delta.linksChanged === false && delta.added.length === 0 && delta.vanished.length === 0) return;
    const pathsStmt = await db.prepare('SELECT "path" FROM frontmatter');
    const nodes = ((await pathsStmt.all()) as Array<{ path: string }>).map((r) => r.path);
    const ranks = pagerank(nodes, await linkEdges(db));
    if (ranks.size === 0) return;
    await db.runBatch(
      'UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?',
      [...ranks].map(([path, value]) => [value, path])
    );
  },
};
