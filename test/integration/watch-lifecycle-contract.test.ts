import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { STATE_DIR, search } from 'sensemaking';
import { startMeasuredWatcher } from '../../benchmark/lib/measured-watcher.mjs';
import { nativeObserverDeadlineMs, waitForNativeIndex } from '../../benchmark/lib/native-observer.mjs';
import { captureFileManifest, readIndexSnapshot, verifyIndexSnapshot } from '../../benchmark/lib/work-tree.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { openTreeForStore, type ParityStoreName, STORE_NAMES, withTreeForStore } from '../lib/stores.ts';

type Store = Awaited<ReturnType<typeof openTreeForStore>>['store'];

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
  await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
    assert.deepEqual(await searchPaths(opened, cfg, query), ['a.md'], `${store}: fresh watcher search`);
    assert.deepEqual(await searchPaths(opened, cfg, 'legacyneedle'), [], `${store}: stale watcher search`);
    const row = (await (await opened.prepare('SELECT "path", text FROM content WHERE "path" = ?')).get('a.md')) as { path: string; text: string };
    assert.deepEqual(row, { path: 'a.md', text: expectedRow.text }, `${store}: fresh watcher content`);
  });
}

describe('public watcher freshness lifecycle', () => {
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
      closePromise = watcher.close(5_000, 'EEXIST');
      const [rejected, closed] = await Promise.all([watcher.waitFor('run-watch-rejected', started.next, 5_000), closePromise]);
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
      assert.equal(rejection?.error?.code, 'WATCH_ACTIVE');
      firstClose = first.close(5_000, firstOutcome.event.type === 'run-watch-rejected' ? 'WATCH_ACTIVE' : null);
      secondClose = second.close(5_000, secondOutcome.event.type === 'run-watch-rejected' ? 'WATCH_ACTIVE' : null);
      await Promise.all([firstClose, secondClose]);
    } finally {
      firstClose ??= first.close(5_000, first.events.find((event) => event.type === 'run-watch-rejected')?.error?.code ?? null);
      secondClose ??= second.close(5_000, second.events.find((event) => event.type === 'run-watch-rejected')?.error?.code ?? null);
      await Promise.all([firstClose, secondClose]);
    }
  });
});
