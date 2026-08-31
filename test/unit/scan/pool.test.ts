import assert from 'node:assert';
import type { Config } from 'sensemaking';
import { listFiles } from '../../../src/scan/index.ts';
import { ParsePool } from '../../../src/scan/pool.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

const cfg: Config = { presets: { default: { include: ['**/*.md'] } }, queries: {} };

describe('ParsePool', () => {
  it('creates one pool on the first run() and reuses it on a later call, even with a different maxWorkers', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    const files = listFiles(cfg, baseDir);

    const pool = new ParsePool();
    assert.equal(pool.poolsCreated, 0, 'a pool was constructed before the first run()');
    await pool.run(files, [], cfg, undefined, 2);
    assert.equal(pool.poolsCreated, 1, 'first run() did not construct a pool');

    // A different maxWorkers must not force a second pool: the first dispatch fixes the size.
    await pool.run(files, [], cfg, undefined, 8);
    assert.equal(pool.poolsCreated, 1, 'second run() constructed a second pool instead of reusing the first');

    await pool.close();
    await pool.run(files, [], cfg, undefined, 2);
    assert.equal(pool.poolsCreated, 2, 'run() after close() did not construct a fresh pool');
    await pool.close();
  });

  it('close() before any run() is a no-op', async () => {
    const pool = new ParsePool();
    await pool.close();
  });
});
