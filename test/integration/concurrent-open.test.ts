import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { packageRoot } from '../lib/scratch.ts';
import { hasCapability } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// duckdb and turso hold the cache file for their connection's whole life, so two commands on one
// tree collide at open() rather than at a transaction. Measured before the retry landed: 1 of 3
// succeeded, warm as well as cold, and every failure returned inside 200 ms.

// Spawned from the package root with --config, never cwd=scratch: Windows will not delete a live
// process's cwd (same reason as shutdown.test.ts).
describe('concurrent commands on one tree', () => {
  const cli = join(packageRoot, 'bin', 'cli.js');
  const PARALLEL = 3;

  function tree(store: string, count = 40): string {
    const baseDir = tmpTree();
    for (let i = 0; i < count; i++) writeNote(baseDir, `n${i}.md`, { body: `widget${i % 5} body` });
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    return baseDir;
  }

  const search = (baseDir: string) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const p = spawn(process.execPath, [cli, 'search', 'widget1', '--k', '3', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot });
      let stderr = '';
      p.stderr.on('data', (d) => {
        stderr += d;
      });
      p.on('close', (code) => resolve({ code, stderr }));
    });

  // Warm, not cold: the file lock is the whole mechanism here and it is held on every open, so a
  // warm tree isolates it from the separate cold-build races. sqlite is excluded because its lock
  // is shared: a warm tree has nothing left to reparse, so two commands never reach a write
  // transaction together, and its own concurrency defect is cold-only (below).
  for (const store of ['duckdb', 'turso'] as const) {
    it(`${store}: ${PARALLEL} simultaneous searches on a warm tree all succeed`, async function () {
      if (!hasCapability(store, 'lexical')) this.skip();
      const baseDir = tree(store);
      await search(baseDir);

      const results = await Promise.all(Array.from({ length: PARALLEL }, () => search(baseDir)));
      const failed = results.filter((r) => r.code !== 0);
      // Any surviving failure must be ours. Our message means the retry ran and the deadline
      // expired; the engine's raw text means isLocked never recognised the error, which is what an
      // engine rewording its lock message looks like. Different bugs, different fixes, so the spec
      // separates them rather than leaving the next reader to diff two platforms' stderr.
      for (const r of failed) {
        assert.match(r.stderr, /another sense process is using/, `${store}: isLocked did not recognise this as a held lock, so no retry ran -- ${r.stderr.replace(/\s+/g, ' ')}`);
      }
      // Whole stderr, not its last line: the engines word this across several lines on Windows, and
      // the tail alone cannot tell a predicate that failed to match from a deadline that ran out.
      assert.deepEqual(
        failed.map((r) => r.stderr.trim().split('\n').pop()),
        [],
        `${store}: every concurrent open must wait for the lock rather than fail`
      );
    });
  }

  // sqlite's lock is shared (busy_timeout queues a second BEGIN IMMEDIATE rather than failing
  // it), so on a cold tree two processes both classify every file as "added" from a frontmatter
  // read taken before either holds the write lock. The first process's write transaction commits
  // in full; the second, still trusting its stale "added" classification, then reruns bare
  // INSERTs against rows the first already created -- a primary-key race, not a lock, so a retry
  // would only mask it. 200 files: small counts don't reliably overlap the two reconciles.
  it('sqlite: 3 simultaneous searches on a cold tree all succeed', async function () {
    if (!hasCapability('sqlite', 'lexical')) this.skip();
    const baseDir = tree('sqlite', 200);

    const results = await Promise.all(Array.from({ length: PARALLEL }, () => search(baseDir)));
    const failed = results.filter((r) => r.code !== 0);
    assert.deepEqual(
      failed.map((r) => r.stderr.trim().split('\n').pop()),
      [],
      'sqlite: every concurrent cold reconcile must write without a primary-key collision'
    );
  });
});
