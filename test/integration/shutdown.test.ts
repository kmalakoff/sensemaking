import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { STORE_NAMES } from '../../src/config/index.ts';
import { packageRoot } from '../lib/scratch.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// Interrupting a cold build: the store is mid-write when the signal lands; threads die with
// the process, so the claim is the process exits and the tree is usable afterwards.

// Every spawn runs from the package root with --config, never cwd=scratch: Windows won't delete
// a live process's cwd, and duckdb's install children outlive the signaled process and would strand it.
describe('interrupting a pooled cold build', () => {
  const cli = join(packageRoot, 'bin', 'cli.js');
  // Every store, read from STORE_NAMES rather than listed here: the signal kills the process before
  // `store.close()` can run, and what each engine leaves behind is its own (a WAL it recovers, a
  // native handle, a Tantivy index mid-write), so a new store owes this proof too.
  const stores = STORE_NAMES;

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
      const child = spawn(process.execPath, [cli, 'build', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot, detached: true });
      let exited = false;
      const childClosed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('close', (code, signal) => {
          exited = true;
          resolve({ code, signal });
        });
      });
      const childExit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once('error', reject);
        childClosed.then(resolve);
      });
      void childExit.catch(() => undefined);

      try {
        // Signal only once the reparse stage has actually started, so the test is not racing the
        // build to completion and silently proving nothing.
        let readyTimer: ReturnType<typeof setTimeout>;
        const reparseReady = new Promise<void>((resolve, reject) => {
          readyTimer = setTimeout(() => {
            if (child.pid) signalProcessTree(child, 'SIGKILL');
            reject(new Error('reparse never started'));
          }, 30_000);
          child.stderr.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('reparsing files')) {
              clearTimeout(readyTimer);
              resolve();
            }
          });
        });
        await Promise.race([
          reparseReady,
          childExit.then(
            ({ code, signal }) => {
              clearTimeout(readyTimer);
              throw new Error(`build exited before reparse started: exit ${code ?? 'null'}${signal ? ` (${signal})` : ''}`);
            },
            (error) => {
              clearTimeout(readyTimer);
              throw new Error(`build failed before reparse started: ${error instanceof Error ? error.message : String(error)}`);
            }
          ),
        ]);
        child.kill('SIGINT');

        // A live pool would keep the event loop alive; the assertion is that it does not.
        const outcome = await Promise.race([
          childExit,
          new Promise<null>((resolve) => {
            const killTimer = setTimeout(() => {
              if (child.pid) signalProcessTree(child, 'SIGKILL');
              resolve(null);
            }, 10_000);
            childExit.then(
              () => clearTimeout(killTimer),
              () => clearTimeout(killTimer)
            );
          }),
        ]);
        assert.ok(outcome, 'process did not exit within 10s of SIGINT during a pooled reparse');
        // A clean exit code would mean the build finished before the signal landed, so the test
        // would be proving nothing about an interrupted one.
        assert.equal(outcome.signal, 'SIGINT', `expected death by SIGINT mid-build, got ${JSON.stringify(outcome)}`);

        const after = spawnSync(process.execPath, [cli, 'sql', 'SELECT COUNT(*) AS n FROM frontmatter', '--format', 'json', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot, encoding: 'utf8' });
        assert.equal(after.status, 0, `rebuild after interrupt failed: ${after.stderr}`);
        assert.equal(JSON.parse(after.stdout)[0].n, 800);
      } finally {
        if (!exited && child.pid) signalProcessTree(child, 'SIGKILL');
        await childClosed;
      }
    });
});
