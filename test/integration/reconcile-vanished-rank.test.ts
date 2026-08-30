import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { forEachStore, openTreeForStore, type ParityStoreName } from '../lib/stores.ts';
import { scratchDir, writeNote } from '../lib/tree.ts';

// Pins reconcile.ts's ordering: the vanished-frontmatter DELETE must run before the feature-hook
// loop, so rank.afterReconcile's `SELECT "path" FROM frontmatter` node set never includes a file
// that was just deleted from disk. A phantom node dilutes PageRank mass across every survivor.

const NODE_COUNT = 30;

// 30 cross-linked notes plus a hub every note links to, so PageRank produces distinct values.
// `includeHub` controls whether hub.md itself is written, not whether other notes reference it --
// the two trees this test compares must contain identical "[[hub]]" text either way.
function buildTree(baseDir: string, includeHub: boolean): void {
  for (let i = 0; i < NODE_COUNT; i++) {
    const targets = [`n${(i + 1) % NODE_COUNT}`, `n${(i * 7 + 3) % NODE_COUNT}`, 'hub'];
    writeNote(baseDir, `n${i}.md`, { body: `note ${i} links to ${targets.map((t) => `[[${t}]]`).join(' and ')}.` });
  }
  if (includeHub) writeNote(baseDir, 'hub.md', { body: 'hub links back to [[n0]] and [[n1]].' });
}

async function readRanks(store: ParityStoreName, baseDir: string): Promise<Map<string, number>> {
  const { store: s } = await openTreeForStore(store, baseDir);
  const rows = (await (await s.prepare('SELECT "path", "_rank" FROM frontmatter')).all()) as Array<{ path: string; _rank: number }>;
  await s.close();
  return new Map(rows.map((r) => [r.path, r._rank]));
}

describe('reconcile: vanished frontmatter rows must not leak into rank.afterReconcile', () => {
  it('delete-then-reconcile matches a from-scratch build without the deleted note, across every store', async () => {
    await forEachStore(async (store) => {
      const withHub = scratchDir(`reconcile-rank-with-hub-${store}`);
      buildTree(withHub, true);
      // cold build: hub.md exists, so every note's rank is computed with hub as a real node.
      {
        const { store: s } = await openTreeForStore(store, withHub);
        await s.close();
      }

      // hub.md vanishes; reconciling again is where the delete-before-hooks ordering matters.
      rmSync(join(withHub, 'hub.md'));
      const afterDelete = await readRanks(store, withHub);

      // A tree that never had hub.md: the oracle rank.afterReconcile must match.
      const withoutHub = scratchDir(`reconcile-rank-without-hub-${store}`);
      buildTree(withoutHub, false);
      const freshBuild = await readRanks(store, withoutHub);

      assert.deepEqual([...afterDelete.keys()].sort(), [...freshBuild.keys()].sort(), `${store}: surviving path set must match the from-scratch build`);

      // PageRank is deterministic power iteration, but node/edge SELECTs carry no ORDER BY, so
      // summation order (and therefore the last bits of each float) can differ across builds.
      // A phantom node's effect is a real fraction of rank mass, orders of magnitude above that
      // float noise, so a tight absolute tolerance still fails the moment one leaks in.
      for (const [path, rank] of freshBuild) {
        const got = afterDelete.get(path) as number;
        assert.ok(Math.abs(got - rank) < 1e-9, `${store}: ${path} rank diverged after delete+reconcile (${got}) vs from-scratch build (${rank})`);
      }
    });
  });
});
