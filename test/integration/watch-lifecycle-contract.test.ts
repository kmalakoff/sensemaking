import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { search } from 'sensemaking';
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
});
