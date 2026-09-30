import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { loadConfig, open, type ResolvedConfig, runWatch, STATE_DIR, SUPPORTED_CONFIG_VERSION, search } from 'sensemaking';
import { startMeasuredWatcher } from '../../benchmark/lib/measured-watcher.mjs';
import { nativeObserverDeadlineMs, waitForNativeIndex } from '../../benchmark/lib/native-observer.mjs';
import { captureFileManifest, readIndexSnapshot, verifyIndexSnapshot } from '../../benchmark/lib/work-tree.mjs';
import { getProvider } from '../../src/embed/registry.ts';
import { openStoreFor } from '../../src/store/index.ts';
import type { BuildRequirement } from '../../src/store/open.ts';
import { readWatchClaim } from '../../src/watch-claim.ts';
import { runCli } from '../lib/cli.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { listen } from '../lib/server.ts';
import { openTreeForStore, type ParityStoreName, STORE_NAMES } from '../lib/stores.ts';

type Store = Awaited<ReturnType<typeof open>>['store'];

function observeOperation(operation: Promise<void>): Promise<PromiseSettledResult<void>> {
  return Promise.allSettled([operation]).then(([result]) => result);
}

async function controlledWatchProvider() {
  let documentRequests = 0;
  let markDocumentsStarted!: () => void;
  const documentsStarted = new Promise<void>((resolve) => {
    markDocumentsStarted = () => resolve();
  });
  let releaseDocuments!: () => void;
  const documentsReleased = new Promise<void>((resolve) => {
    releaseDocuments = () => resolve();
  });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as { input: string[] };
      const reply = () => {
        if (res.destroyed) return;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: body.input.map(() => ({ embedding: [1, 0] })) }));
      };
      if (body.input.length === 1 && body.input[0] === 'dimension probe') {
        reply();
        return;
      }
      documentRequests++;
      markDocumentsStarted();
      void documentsReleased.then(reply);
    });
  });
  const endpoint = await listen(server);
  return {
    documentsStarted,
    endpoint,
    get documentRequests() {
      return documentRequests;
    },
    releaseDocuments,
    server,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

function rowHash(row: { title: string; summary: string; text: string }): string {
  return createHash('sha256')
    .update(JSON.stringify([row.title, row.summary, row.text]))
    .digest('hex');
}

function setMtime(baseDir: string, path: string, mtime: number): void {
  utimesSync(join(baseDir, path), mtime / 1000, mtime / 1000);
}

async function searchPaths(store: Store, cfg: Parameters<typeof search>[1], query: string): Promise<string[]> {
  return (await search(store, cfg, query, { k: 10 })).map((row) => row.path as string).sort();
}

function assertOnlyKnownNodeWarnings(stderr: string): void {
  const unexpected = stderr.replaceAll(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)(?:\r?\n|$)/g, '');
  if (stderr) process.stderr.write(stderr);
  assert.equal(unexpected, '', `the child must not report an unexpected shutdown error; captured stderr:\n${stderr}`);
}

async function verifyFreshPublicSearch(store: ParityStoreName, baseDir: string, query: string, expectedRow: { title: string; summary: string; text: string }): Promise<void> {
  const cfg = loadConfig(join(baseDir, 'sense.config.json'), { writeMigration: false });
  const opened = await open(cfg, { build: false });
  try {
    assert.deepEqual(await searchPaths(opened.store, cfg, query), ['a.md'], `${store}: fresh watcher search`);
    assert.deepEqual(await searchPaths(opened.store, cfg, 'legacyneedle'), [], `${store}: stale watcher search`);
    const row = (await (await opened.store.prepare('SELECT "path", text FROM content WHERE "path" = ?')).get('a.md')) as { path: string; text: string };
    assert.deepEqual(row, { path: 'a.md', text: expectedRow.text }, `${store}: fresh watcher content`);
  } finally {
    await opened.store.close();
  }
}

function verifyFreshCliSearch(store: ParityStoreName, baseDir: string): void {
  const fresh = runCli(['search', 'freshneedle', '--no-build', '--format', 'json'], { cwd: baseDir });
  assert.equal(fresh.status, 0, `${store}: CLI no-build query failed: ${fresh.stderr}`);
  assert.deepEqual(
    (JSON.parse(fresh.stdout) as Array<{ path: string }>).map((row) => row.path),
    ['a.md'],
    `${store}: CLI no-build query must return the freshly committed authored path`
  );

  const stale = runCli(['search', 'legacyneedle', '--no-build', '--format', 'json'], { cwd: baseDir });
  assert.equal(stale.status, 0, `${store}: CLI absent no-build query failed: ${stale.stderr}`);
  assert.deepEqual(JSON.parse(stale.stdout), [], `${store}: CLI no-build query must not return the old indexed term`);
}

describe('public watcher freshness lifecycle', () => {
  it('returns before claim creation when its caller signal is already aborted', async () => {
    const tree = scratchDir('watch-pre-aborted');
    writeFileSync(join(tree, 'a.md'), 'never indexed\n');
    const cfg: ResolvedConfig = { version: SUPPORTED_CONFIG_VERSION, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {}, rootDir: tree, configDir: tree, baseDir: tree, configPath: null };
    const controller = new AbortController();
    controller.abort({ kind: 'pre-aborted watch' });

    await runWatch(cfg, { signal: controller.signal });
    assert.equal(readWatchClaim(tree), null);
    assert.equal(existsSync(join(tree, STATE_DIR)), false, 'pre-aborted watch created derived state before returning');
  });

  it('cancels startup provider work without catch-up or final preparation', async () => {
    const provider = await controlledWatchProvider();
    let controller: AbortController | undefined;
    let outcome: Promise<PromiseSettledResult<void>> | undefined;
    let outcomeConsumed = false;
    let bodyFailed = false;
    let bodyError: unknown;
    try {
      const tree = scratchDir('watch-provider-abort');
      writeFileSync(join(tree, 'a.md'), '# Pending\n\nprovider cancellation\n');
      const cfg: ResolvedConfig = {
        version: SUPPORTED_CONFIG_VERSION,
        store: 'sqlite',
        presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
        embed: { provider: 'openai', model: 'watch-cancel', url: provider.endpoint },
        queries: {},
        rootDir: tree,
        configDir: tree,
        baseDir: tree,
        configPath: null,
      };
      const core = await openStoreFor(cfg, { build: true, requirements: new Set<BuildRequirement>(['core']) });
      try {
        assert.equal((await core.store.vectors.pending()).length, 1);
      } finally {
        await core.store.close();
      }
      await getProvider(cfg);

      const events: Array<{ type: string; message?: string }> = [];
      const reason = { kind: 'authored watch cancellation' };
      controller = new AbortController();
      outcome = observeOperation(runWatch(cfg, { signal: controller.signal, onEvent: (event) => events.push(event) }));
      const first = await Promise.race([provider.documentsStarted.then(() => ({ kind: 'started' as const })), outcome.then((result) => ({ kind: 'settled' as const, result }))]);
      if (first.kind === 'settled') {
        outcomeConsumed = true;
        if (first.result.status === 'rejected') throw first.result.reason;
        throw new Error('watch resolved before the controlled provider request started');
      }

      controller.abort(reason);
      const canceled = await outcome;
      outcomeConsumed = true;
      if (canceled.status === 'rejected') throw canceled.reason;
      assert.deepEqual(
        events.filter((event) => event.type === 'reconcile-error'),
        [],
        'caller cancellation was reported as an arbitrary reconcile error'
      );
      assert.equal(provider.documentRequests, 1, 'watch restarted canceled provider work during catch-up or final preparation');
      assert.equal(readWatchClaim(tree), null, 'caller cancellation left the watch claim active');

      const reopened = await open(cfg, { build: false });
      try {
        assert.equal((await reopened.store.vectors.pending()).length, 1, 'canceled startup provider work published its current batch');
        assert.equal(((await (await reopened.store.prepare('SELECT COUNT(*) AS n FROM frontmatter')).get()) as { n: number }).n, 1, 'caller cancellation withdrew the committed core generation');
      } finally {
        await reopened.store.close();
      }
    } catch (err) {
      bodyFailed = true;
      bodyError = err;
    }

    controller?.abort({ kind: 'watch test cleanup' });
    provider.releaseDocuments();
    const cleanupErrors: unknown[] = [];
    if (outcome && !outcomeConsumed) {
      const pending = await outcome;
      if (pending.status === 'rejected') cleanupErrors.push(pending.reason);
    }
    try {
      await closeServer(provider.server);
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (bodyFailed && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], 'watch cancellation test and cleanup both failed');
    if (bodyFailed) throw bodyError;
    if (cleanupErrors.length > 0) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'watch cancellation cleanup failed');
  });

  it('does not hide a real callback error when the caller signal is also aborted', async () => {
    const tree = scratchDir('watch-abort-and-error');
    writeFileSync(join(tree, 'a.md'), 'callback failure\n');
    const cfg: ResolvedConfig = { version: SUPPORTED_CONFIG_VERSION, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {}, rootDir: tree, configDir: tree, baseDir: tree, configPath: null };
    const controller = new AbortController();
    const cancellation = { kind: 'simultaneous cancellation' };
    const callbackError = new Error('authored callback failure');

    const [outcome] = await Promise.allSettled([
      runWatch(cfg, {
        signal: controller.signal,
        onEvent(event) {
          if (event.type !== 'started') return;
          controller.abort(cancellation);
          throw callbackError;
        },
      }),
    ]);
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.reason, callbackError, 'simultaneous caller abort hid the real callback failure');
    assert.equal(readWatchClaim(tree), null);
  });

  for (const store of STORE_NAMES)
    it(`${store}: native freshness before public search and after reopen`, async function () {
      this.timeout(30_000);
      const tree = scratchDir(`watch-lifecycle-${store}`);
      const configPath = join(tree, 'sense.config.json');
      writeFileSync(configPath, JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
      writeFileSync(join(tree, 'a.md'), 'legacyneedle body.\n');
      setMtime(tree, 'a.md', 4102444800000);

      const baselineManifest = captureFileManifest(tree);
      const initial = await openTreeForStore(store, tree);
      try {
        const baselineRow = { title: '', summary: '', text: 'legacyneedle body.' };
        const baselineSnapshot = await readIndexSnapshot(initial.store, { expectedContent: new Map([['a.md', baselineRow]]) });
        verifyIndexSnapshot(baselineSnapshot, baselineManifest, `${store}: baseline`);
      } finally {
        await initial.store.close();
      }

      const deadlineMs = await nativeObserverDeadlineMs(packageRoot, tree);
      // A missed or delayed fs notification is recovered by the default five-second heartbeat.
      // Give that fallback one derived reconcile budget to finish before calling the watcher stale.
      const watcherDeadlineMs = 5_000 + deadlineMs;
      const watcher = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      try {
        const started = await watcher.waitFor('started', 0, watcherDeadlineMs);
        writeFileSync(join(tree, 'a.md'), 'freshneedle body.\n');
        setMtime(tree, 'a.md', 4102444801000);
        const expectedManifest = captureFileManifest(tree);
        const expectedRow = { title: '', summary: '', text: 'freshneedle body.' };
        await watcher.waitFor('reconciled', started.next, watcherDeadlineMs);
        const observed = await waitForNativeIndex({ pkgRoot: packageRoot, store, configPath, manifest: expectedManifest, expectedContent: [['a.md', rowHash(expectedRow)]], authoredContent: [['a.md', expectedRow]] }, deadlineMs);
        assert.equal(observed.state, 'ready', `${store}: watcher native state`);
        watcher.assertRunning();
        await verifyFreshPublicSearch(store, tree, 'freshneedle', expectedRow);
        verifyFreshCliSearch(store, tree);
        watcher.assertRunning();
      } finally {
        await watcher.close(deadlineMs);
      }
      await verifyFreshPublicSearch(store, tree, 'freshneedle', { title: '', summary: '', text: 'freshneedle body.' });
    });

  it('rejects cleanly when shutdown cannot reopen the state directory', async function () {
    this.timeout(30_000);
    const base = scratchDir('watch-shutdown-error');
    const configDir = join(base, 'config');
    const tree = join(base, 'tree');
    const configPath = join(configDir, 'sense.config.json');
    const stateDir = join(configDir, STATE_DIR);
    mkdirSync(configDir);
    mkdirSync(tree);
    writeFileSync(configPath, JSON.stringify({ version: 5, root: '../tree', store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeFileSync(join(tree, 'a.md'), 'watch shutdown error.\n');

    const watcher = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
    let closePromise: ReturnType<typeof watcher.close> | null = null;
    try {
      const started = await watcher.waitFor('started', 0, 5_000);
      safeRmSync(stateDir, { recursive: true, force: true });
      writeFileSync(stateDir, 'state directory collision');
      await watcher.requestGracefulStop();
      const rejected = await watcher.waitFor('run-watch-rejected', started.next, 5_000);
      closePromise = watcher.close(5_000, 'EEXIST');
      const closed = await closePromise;
      assert.equal(rejected.event.error.code, 'EEXIST');
      assert.deepEqual({ code: closed.code, signal: closed.signal }, { code: 0, signal: null });
      assertOnlyKnownNodeWarnings(closed.stderr);
      await assert.rejects(watcher.close(5_000), { name: 'Error', message: /^runWatch rejected: EEXIST/ });
    } finally {
      if (closePromise) await closePromise;
      else await watcher.close(5_000);
    }
  });

  it('grants one atomic claim to two coordinated contenders', async function () {
    this.timeout(30_000);
    const tree = scratchDir('watch-coordinated-contenders');
    const configPath = join(tree, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeFileSync(join(tree, 'a.md'), 'coordinated claim.\n');
    const first = startMeasuredWatcher({ pkgRoot: packageRoot, configPath, deferred: true });
    const second = startMeasuredWatcher({ pkgRoot: packageRoot, configPath, deferred: true });
    let firstClose: ReturnType<typeof first.close> | null = null;
    let secondClose: ReturnType<typeof second.close> | null = null;
    try {
      await Promise.all([first.ready, second.ready]);
      await Promise.all([first.start(), second.start()]);
      const [firstOutcome, secondOutcome] = await Promise.all([first.waitForAny(['started', 'run-watch-rejected'], 0, 10_000), second.waitForAny(['started', 'run-watch-rejected'], 0, 10_000)]);
      assert.deepEqual([firstOutcome.event.type, secondOutcome.event.type].sort(), ['run-watch-rejected', 'started'], 'the native write transaction must grant exactly one claim');
      const winner = firstOutcome.event.type === 'started' ? first : second;
      const loser = winner === first ? second : first;
      const rejection = loser.events.find((event) => event.type === 'run-watch-rejected');
      assert.equal(rejection?.error?.code, 'WATCH_ACTIVE', JSON.stringify(rejection));
      firstClose = first.close(5_000, firstOutcome.event.type === 'run-watch-rejected' ? 'WATCH_ACTIVE' : null);
      secondClose = second.close(5_000, secondOutcome.event.type === 'run-watch-rejected' ? 'WATCH_ACTIVE' : null);
      await Promise.all([firstClose, secondClose]);
      // Read raw disk bytes, not loadConfig: loadConfig migrates in memory regardless of
      // whether either contender's write actually landed, so it can't prove the disk moved.
      const finalRaw = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.equal(finalRaw.version, SUPPORTED_CONFIG_VERSION, 'both contenders must leave the on-disk config migrated to the current version');
      assert.equal(finalRaw.build, true, 'the v5 -> v6 step must have published build:true regardless of which contender lost the race');
    } finally {
      firstClose ??= first.close(5_000, first.events.find((event) => event.type === 'run-watch-rejected')?.error?.code ?? null);
      secondClose ??= second.close(5_000, second.events.find((event) => event.type === 'run-watch-rejected')?.error?.code ?? null);
      await Promise.all([firstClose, secondClose]);
    }
  });
});
