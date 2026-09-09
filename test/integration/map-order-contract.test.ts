import assert from 'node:assert';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { mapTree } from 'sensemaking';
import { forEachStore, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

const PATHS = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, '0')}.md`);
const TIED_MTIME = Date.parse('2030-02-03T04:05:06.789Z');

function isolatedTree(): string {
  const baseDir = tmpTree();
  for (const path of PATHS) {
    writeNote(baseDir, path, { frontmatter: { title: path }, body: `isolated ${path}` });
    utimesSync(join(baseDir, path), TIED_MTIME / 1000, TIED_MTIME / 1000);
  }
  return baseDir;
}

describe('mapTree ordering contract', () => {
  it('uses bytewise path order at the hub and recent limits when rank and mtime are tied', async () => {
    const baseDir = isolatedTree();
    await forEachStore(async (name) => {
      await withTreeForStore(name, baseDir, async ({ store }) => {
        const rankRows = (await (await store.prepare('SELECT "path", "_rank" AS rank FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; rank: number }>;
        assert.equal(rankRows.length, PATHS.length, `${name}: rank row count`);
        assert.ok(
          rankRows.every((row) => Number.isFinite(row.rank)),
          `${name}: isolated notes must have finite ranks`
        );
        assert.equal(new Set(rankRows.map((row) => row.rank)).size, 1, `${name}: isolated notes must have equal ranks`);

        const mtimeRows = (await (await store.prepare('SELECT "path", "_mtime" AS mtime FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; mtime: number }>;
        assert.equal(mtimeRows.length, PATHS.length, `${name}: mtime row count`);
        assert.equal(new Set(mtimeRows.map((row) => row.mtime)).size, 1, `${name}: mtimes must be exactly tied`);

        const result = await mapTree(store, { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null });
        assert.deepEqual(
          result.hubs.map((row) => row.path),
          PATHS.slice(0, 8),
          `${name}: hubs must use path order at LIMIT 8`
        );
        assert.equal(result.hubs.length, 8, `${name}: hubs limit`);
        assert.deepEqual(
          result.recent.map((row) => row.path),
          PATHS.slice(0, 5),
          `${name}: recent must use path order at LIMIT 5`
        );
        assert.equal(result.recent.length, 5, `${name}: recent limit`);
      });
    });
  });
});
