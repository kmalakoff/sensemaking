import assert from 'node:assert';
import { utimesSync } from 'node:fs';
import { mapTree } from 'sensemaking';
import { renderMap } from '../../../src/output/output.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// mapTree's `recent` query near the end of the function: a fresh checkout stamps every file
// with the checkout time, so raw mtime order can silently pass off a tie as edit history.

describe('mapTree recent caveat', () => {
  it('flags a checkout: same mtime second, differing ms, across a majority of files', async () => {
    const baseDir = tmpTree();
    const paths: string[] = [];
    for (let i = 0; i < 10; i++) {
      const relPath = `note${i}.md`;
      writeNote(baseDir, relPath, { body: `note ${i}` });
      paths.push(relPath);
    }
    // One second boundary, differing ms within it -- the clone shape. Identical raw values
    // would pass even with a broken (non-second-truncating) implementation.
    const baseSec = Math.floor(Date.now() / 1000);
    paths.forEach((relPath, i) => {
      const mtime = new Date(baseSec * 1000 + i * 50);
      utimesSync(`${baseDir}/${relPath}`, mtime, mtime);
    });

    const { store, cfg } = await openTree(baseDir);
    const result = await mapTree(store, cfg);
    assert.ok(result.recentCaveat, 'expected a checkout caveat');
    assert.match(result.recentCaveat as string, /10 of 10 files share one modified second/);
    assert.match(renderMap(result), /10 of 10 files share one modified second/);
  });

  it('does not flag a natural spread of mtimes across distinct seconds', async () => {
    const baseDir = tmpTree();
    const paths: string[] = [];
    for (let i = 0; i < 10; i++) {
      const relPath = `note${i}.md`;
      writeNote(baseDir, relPath, { body: `note ${i}` });
      paths.push(relPath);
    }
    const baseSec = Math.floor(Date.now() / 1000);
    paths.forEach((relPath, i) => {
      const mtime = new Date((baseSec + i * 10) * 1000);
      utimesSync(`${baseDir}/${relPath}`, mtime, mtime);
    });

    const { store, cfg } = await openTree(baseDir);
    const result = await mapTree(store, cfg);
    assert.equal(result.recentCaveat, null);
    assert.ok(!renderMap(result).includes('share one modified second'));
  });
});
