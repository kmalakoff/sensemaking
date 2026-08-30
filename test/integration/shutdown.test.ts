import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { packageRoot } from '../lib/scratch.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// Interrupting a cold build is the one place worker threads meet process shutdown. Threads die
// with the process, so nothing is orphaned, but the store is mid-write when the signal lands:
// what matters is that the process still exits and the tree is usable afterwards.
//
// Every spawn below runs from the package root and reaches the tree through --config, never
// with cwd set to the scratch dir. Windows refuses to delete a directory that is any live
// process's working directory, and the duckdb leg spawns its own install children that outlive
// the one this test signals, so a cwd there strands the scratch tree for the whole run.
describe('interrupting a pooled cold build', () => {
  const cli = join(packageRoot, 'bin', 'cli.js');
  // Both stores, because the signal kills the process before `store.close()` can run: what is
  // left behind is a write-ahead log the engine has to recover on its own, and duckdb's is a
  // native handle rather than Node's built-in SQLite.
  const stores = ['sqlite', 'duckdb'];

  // Past the 200-file pooling threshold, with bodies big enough that the reparse stage lasts
  // long enough to be interrupted rather than finishing before the signal arrives.
  function bigTree(store: string): string {
    const baseDir = tmpTree();
    for (let i = 0; i < 800; i++) writeNote(baseDir, `n${i}.md`, { frontmatter: { [`k${i}`]: 1 }, body: 'word '.repeat(4000) });
    // The CLI reads a config off disk; the in-memory config the library tests use has no file.
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    return baseDir;
  }

  for (const store of stores)
    it(`exits on SIGINT during the reparse, and the ${store} tree still builds afterwards`, async () => {
      const baseDir = bigTree(store);
      const child = spawn(process.execPath, [cli, 'status', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot });

      // Signal only once the reparse stage has actually started, so the test is not racing the
      // build to completion and silently proving nothing.
      await new Promise<void>((resolve, reject) => {
        const killTimer = setTimeout(() => reject(new Error('reparse never started')), 30_000);
        child.stderr.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('reparsing files')) {
            clearTimeout(killTimer);
            resolve();
          }
        });
      });
      child.kill('SIGINT');

      // A live pool would keep the event loop alive; the assertion is that it does not.
      const outcome = await new Promise<{ code: number | null; signal: string | null } | null>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(null);
        }, 10_000);
        child.on('exit', (code, signal) => {
          clearTimeout(killTimer);
          resolve({ code, signal });
        });
      });
      assert.ok(outcome, 'process did not exit within 10s of SIGINT during a pooled reparse');
      // A clean exit code would mean the build finished before the signal landed, so the test
      // would be proving nothing about an interrupted one.
      assert.equal(outcome.signal, 'SIGINT', `expected death by SIGINT mid-build, got ${JSON.stringify(outcome)}`);

      const after = spawnSync(process.execPath, [cli, 'sql', 'SELECT COUNT(*) AS n FROM frontmatter', '--format', 'json', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot, encoding: 'utf8' });
      assert.equal(after.status, 0, `rebuild after interrupt failed: ${after.stderr}`);
      assert.equal(JSON.parse(after.stdout)[0].n, 800);
    });
});
