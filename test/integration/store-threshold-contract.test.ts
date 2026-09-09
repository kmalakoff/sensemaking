import assert from 'node:assert';
import { unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { search } from 'sensemaking';
import { FTS_REBUILD_THRESHOLD } from '../../src/store/turso/reconcile.ts';
import { type openTreeForStore, type ParityStoreName, STORE_NAMES, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

const STABLE_PATH = 'stable.md';
const BASE_MTIME = 4102444800000;
const CHURN_COUNTS = [FTS_REBUILD_THRESHOLD - 1, FTS_REBUILD_THRESHOLD, FTS_REBUILD_THRESHOLD + 1];
type Store = Awaited<ReturnType<typeof openTreeForStore>>['store'];

function changedPath(index: number): string {
  return `bulk-${String(index).padStart(3, '0')}.md`;
}

function setMtime(baseDir: string, path: string, mtime: number): void {
  utimesSync(join(baseDir, path), mtime / 1000, mtime / 1000);
}

function writeInitialTree(churn: number): string {
  const baseDir = tmpTree();
  writeNote(baseDir, STABLE_PATH, { body: 'stable marker' });
  setMtime(baseDir, STABLE_PATH, BASE_MTIME);
  for (let index = 0; index < churn; index++) {
    const path = changedPath(index);
    writeNote(baseDir, path, { body: `legacy marker ${String(index).padStart(3, '0')}` });
    setMtime(baseDir, path, BASE_MTIME + (index + 1) * 1000);
  }
  return baseDir;
}

async function searchPaths(store: Store, cfg: Parameters<typeof search>[1], query: string, k: number): Promise<string[]> {
  const rows = await search(store, cfg, query, { k });
  return rows.map((row) => row.path as string).sort();
}

describe('store lexical rebuild threshold contract', () => {
  async function verifyThreshold(store: ParityStoreName, churn: number): Promise<void> {
    const baseDir = writeInitialTree(churn);
    const allLegacyPaths = Array.from({ length: churn }, (_, index) => changedPath(index)).sort();
    await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
      assert.deepEqual(await searchPaths(opened, cfg, 'legacy', churn + 1), allLegacyPaths, `${store}/${churn}: initial legacy path set`);
    });

    const deletedPath = changedPath(0);
    unlinkSync(join(baseDir, deletedPath));
    const freshPaths: string[] = [];
    const expectedContent: Array<{ path: string; text: string }> = [{ path: STABLE_PATH, text: 'stable marker' }];
    for (let index = 1; index < churn; index++) {
      const path = changedPath(index);
      const text = `fresh marker ${String(index).padStart(3, '0')}`;
      writeNote(baseDir, path, { body: text });
      setMtime(baseDir, path, BASE_MTIME + 1000000 + index * 1000);
      freshPaths.push(path);
      expectedContent.push({ path, text });
    }
    expectedContent.sort((a, b) => a.path.localeCompare(b.path));

    await withTreeForStore(store, baseDir, async ({ store: opened, cfg }) => {
      assert.deepEqual(await searchPaths(opened, cfg, 'fresh', churn + 1), freshPaths.sort(), `${store}/${churn}: fresh path set after reopen`);
      assert.deepEqual(await searchPaths(opened, cfg, 'legacy', churn + 1), [], `${store}/${churn}: stale legacy rows after reopen`);
      assert.deepEqual(await searchPaths(opened, cfg, 'stable', 2), [STABLE_PATH], `${store}/${churn}: unaffected note after reopen`);
      const content = (await (await opened.prepare('SELECT "path", text FROM content ORDER BY "path"')).all()) as Array<{ path: string; text: string }>;
      assert.deepEqual(content, expectedContent, `${store}/${churn}: exact content rows after reopen`);
      assert.equal(
        content.some((row) => row.path === deletedPath),
        false,
        `${store}/${churn}: deleted content row remains`
      );
    });
  }

  for (const store of STORE_NAMES) for (const churn of CHURN_COUNTS) it(`${store}/${churn}: exact authored content and lexical path sets`, () => verifyThreshold(store, churn));
});
