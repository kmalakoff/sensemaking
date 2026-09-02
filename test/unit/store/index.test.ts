import assert from 'assert';
import type { ResolvedConfig } from '../../../src/config/index.ts';
import { clearCache, DB_FILENAME, docCount, getMeta, openStore, SCHEMA_VERSION, setMeta } from '../../../src/store/index.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

function cfgFor(baseDir: string): ResolvedConfig {
  return { presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null };
}

describe('openStore', () => {
  it('opens a real temp tree and returns a working store', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const result = await openStore(cfgFor(baseDir));
    assert.equal(result.store.name, 'sqlite');
    assert.equal(result.parsed, 1);
    assert.equal(await docCount(result.store), 1);
    const row = (await (await result.store.prepare('SELECT title FROM frontmatter WHERE "path" = ?')).get('a.md')) as { title: string };
    assert.equal(row.title, 'A');
    await result.store.close();
  });
});

describe('openStore: store selection and capability gating', () => {
  it('cfg.store "duckdb" opens the duckdb store', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const result = await openStore({ ...cfgFor(baseDir), store: 'duckdb' });
    assert.equal(result.store.name, 'duckdb');
    await result.store.close();
  });

  it('an embed block a preset actually uses opens successfully now that duckdb implements "vectors" (D2)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const result = await openStore({
      ...cfgFor(baseDir),
      store: 'duckdb',
      embed: { model: 'minishlab/potion-retrieval-32M' },
    });
    assert.equal(result.store.name, 'duckdb');
    await result.store.close();
  });

  it('an embed block present but excluded from every preset’s signals does not trip the gate', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const result = await openStore({
      presets: { default: { include: ['*.md'], signals: { words: 1 } } },
      queries: {},
      baseDir,
      configPath: null,
      store: 'duckdb',
      embed: { model: 'minishlab/potion-retrieval-32M' },
    });
    assert.equal(result.store.name, 'duckdb');
    await result.store.close();
  });
});

describe('exported surface', () => {
  // sqlite's cache filename, re-exported here for callers that never import the sqlite store
  // directly (watch.ts, cli/status.ts). TypeScript already proves the re-exports are functions.
  it('DB_FILENAME is sqlite\'s cache filename', () => {
    assert.equal(DB_FILENAME, 'cache.db');
  });

  it('getMeta/setMeta work against a store opened through this module', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openStore(cfgFor(baseDir));
    await setMeta(store, 'k', 'v');
    assert.equal(await getMeta(store, 'k'), 'v');
    await store.close();
  });
});
