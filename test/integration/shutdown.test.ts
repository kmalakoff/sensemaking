import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { jobProblems, spawnOwned } from '../../benchmark/lib/step-process.ts';
import { STORE_NAMES } from '../../src/config/index.ts';
import { packageRoot, tmpTree, writeNote } from '../lib/tree.ts';
import { withinTest } from '../lib/watchdog.ts';

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

  // The balanced ~15.3 MiB workload provides many production byte shares, with bodies big enough
  // that the reparse stage lasts long enough to be interrupted rather than finishing first.
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
      // An owned job: the build and anything it starts (npm installs) are released together, and a
      // killed test runner releases them too. The interrupt itself goes to the build process.
      const job = spawnOwned([process.execPath, cli, 'build', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot });
      job.stdout.resume();
      const stop = (reason: string) => {
        if (job.exited === null) job.fail(reason);
      };

      try {
        // Signal only once the reparse stage has actually started, so the test is not racing the
        // build to completion and silently proving nothing.
        await withinTest(
          'reparse start',
          30_000,
          new Promise<void>((resolve, reject) => {
            job.stderr.on('data', (chunk: Buffer) => {
              if (chunk.toString().includes('reparsing files')) resolve();
            });
            job.result.then((result) => reject(new Error(`build ended before reparse started: ${JSON.stringify(result.command)}; ${jobProblems(result).join('; ') || 'no job problems'}`)));
          }),
          () => stop('reparse never started')
        );
        if (job.commandPid === null || job.exited !== null) throw new Error('build is not running at the interrupt');
        process.kill(job.commandPid, 'SIGINT');

        // A live pool would keep the event loop alive; the assertion is that it does not.
        const result = await withinTest('exit after SIGINT during a pooled reparse', 10_000, job.result, () => stop('process did not exit within 10s of SIGINT'));
        // A clean exit would mean the build finished before the interrupt. Windows PID-directed SIGINT
        // uses TerminateProcess(1); the observing leader's child handle does not record that signal.
        const expected = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGINT' };
        assert.deepEqual(result.command, expected, `expected death by SIGINT mid-build, got ${JSON.stringify(result.command)}`);
        assert.deepEqual(jobProblems(result), [], 'the interrupted build left no process or cleanup problem');

        const after = spawnSync(process.execPath, [cli, 'sql', 'SELECT COUNT(*) AS n FROM frontmatter', '--format', 'json', '--config', join(baseDir, 'sense.config.json')], { cwd: packageRoot, encoding: 'utf8' });
        assert.equal(after.status, 0, `rebuild after interrupt failed: ${after.stderr}`);
        assert.equal(JSON.parse(after.stdout)[0].n, 800);
      } finally {
        stop('test ended');
        await job.result;
      }
    });
});
