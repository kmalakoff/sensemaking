import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { nativeObserverDeadlineMs, signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { SUPPORTED_CONFIG_VERSION } from '../../src/config/types.ts';
import { runCli } from '../lib/cli.ts';
import { packageRoot } from '../lib/scratch.ts';
import { forEachStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// duckdb and turso hold the cache file for their connection's whole life, so two commands on one
// tree collide at open() rather than at a transaction; every failure returns inside 200 ms, which
// is what makes retrying the open cheap enough to do unconditionally.

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

  interface PreparedSearchRun {
    child: ChildProcess;
    result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; spawnError?: string }>;
  }

  function startPreparedSearch(baseDir: string, terms: string): PreparedSearchRun {
    const child = spawn(process.execPath, [cli, 'search', terms, '--no-build', '--format', 'json', '--config', join(baseDir, 'sense.config.json')], {
      cwd: packageRoot,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let spawnError: string | undefined;
    child.once('error', (err) => {
      spawnError = err.message;
    });
    child.stdout?.on('data', (data: Buffer) => (stdout += data.toString()));
    child.stderr?.on('data', (data: Buffer) => (stderr += data.toString()));
    const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; spawnError?: string }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, ...(spawnError ? { spawnError } : {}) }));
    });
    return { child, result };
  }

  async function settlePreparedSearches(runs: PreparedSearchRun[], deadlineMs: number, store: string, lockBudgetMs: number, launchFailure?: { error: unknown }) {
    const all = Promise.allSettled(runs.map((run) => run.result));
    let timer: NodeJS.Timeout | undefined;
    let primaryError: unknown = launchFailure?.error;
    let settled: PromiseSettledResult<Awaited<PreparedSearchRun['result']>>[] | undefined;
    if (!launchFailure) {
      try {
        settled = await Promise.race([
          all,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${store}: prepared no-build launch burst exceeded ${deadlineMs}ms; configured native lock budget=${lockBudgetMs}ms`)), deadlineMs);
          }),
        ]);
      } catch (err) {
        primaryError = err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    const cleanup = await Promise.allSettled(
      runs.map(async ({ child, result }) => {
        if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
        await result;
      })
    );
    settled ??= await all;
    const cleanupErrors = cleanup.flatMap((item) => (item.status === 'rejected' ? [item.reason] : []));
    if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `${store}: prepared no-build burst failed and process cleanup also failed`);
    if (primaryError) throw primaryError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${store}: prepared no-build burst cleanup failed`);
    return settled;
  }

  function withoutKnownSqliteWarning(stderr: string): string {
    const known = stderr.replaceAll(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)(?:\r?\n|$)/g, '');
    if (stderr) process.stderr.write(stderr);
    return known;
  }

  // Warm, not cold: the file lock is the whole mechanism here and it is held on every open, so a
  // warm tree isolates it from the separate cold-build races. sqlite is excluded because its lock
  // is shared: a warm tree has nothing left to reparse, so two commands never reach a write
  // transaction together, and its own concurrency defect is cold-only (below).
  for (const store of ['duckdb', 'turso'] as const) {
    it(`${store}: ${PARALLEL} simultaneous searches on a warm tree all succeed`, async () => {
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
  it('sqlite: 3 simultaneous searches on a cold tree all succeed', async () => {
    const baseDir = tree('sqlite', 200);

    const results = await Promise.all(Array.from({ length: PARALLEL }, () => search(baseDir)));
    const failed = results.filter((r) => r.code !== 0);
    assert.deepEqual(
      failed.map((r) => r.stderr.trim().split('\n').pop()),
      [],
      'sqlite: every concurrent cold reconcile must write without a primary-key collision'
    );
  });

  it('six no-build CLI clients return exact results in a prepared-index launch burst across all stores', async () => {
    await forEachStore(async (store) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'alpha.md', { body: 'authoredalpha unique result' });
      writeNote(baseDir, 'bravo.md', { body: 'authoredbravo unique result' });
      writeNote(baseDir, 'charlie.md', { body: 'authoredcharlie unique result' });
      writeNote(baseDir, 'delta.md', { body: 'authoreddelta unique result' });
      writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, store, build: false, presets: { default: { include: ['**/*.md'] } }, queries: {} }));

      const built = runCli(['build'], { cwd: baseDir });
      assert.equal(built.status, 0, `${store}: explicit build failed: ${built.stderr}`);
      const lockBudgetMs = await nativeObserverDeadlineMs(packageRoot, baseDir);
      const requests = [
        { terms: 'authoredalpha', paths: ['alpha.md'] },
        { terms: 'authoredbravo', paths: ['bravo.md'] },
        { terms: 'authoredcharlie', paths: ['charlie.md'] },
        { terms: 'authoreddelta', paths: ['delta.md'] },
        { terms: 'absent_echo_token', paths: [] },
        { terms: 'absent_foxtrot_token', paths: [] },
      ];
      // Launch all real CLI processes synchronously before awaiting any one child. This is a
      // process launch burst; native file locking may serialize entry into DuckDB or Turso.
      const runs: PreparedSearchRun[] = [];
      let launchFailure: { error: unknown } | undefined;
      try {
        for (const { terms } of requests) runs.push(startPreparedSearch(baseDir, terms));
      } catch (error) {
        launchFailure = { error };
      }
      const outcomes = await settlePreparedSearches(runs, lockBudgetMs * requests.length, store, lockBudgetMs, launchFailure);
      assert.equal(outcomes.length, requests.length, `${store}: every burst client must settle`);
      for (let i = 0; i < requests.length; i++) {
        const outcome = outcomes[i];
        assert.equal(outcome.status, 'fulfilled', `${store}: request ${i} rejected`);
        if (outcome.status !== 'fulfilled') continue;
        const result = outcome.value;
        const label = `${store}: request ${JSON.stringify(requests[i])}; configured native lock budget=${lockBudgetMs}ms`;
        assert.equal(result.spawnError, undefined, `${label}; spawn error=${result.spawnError ?? 'none'}`);
        assert.equal(result.code, 0, `${label}; signal=${result.signal}; stderr=${result.stderr || 'none'}`);
        assert.equal(result.signal, null, `${label}; signal=${result.signal}`);
        assert.equal(withoutKnownSqliteWarning(result.stderr), '', `${label}; unexpected stderr`);
        assert.deepEqual(
          (JSON.parse(result.stdout) as Array<{ path: string }>).map((row) => row.path),
          requests[i].paths,
          `${label}; stdout=${result.stdout}`
        );
      }
    });
  });
});
