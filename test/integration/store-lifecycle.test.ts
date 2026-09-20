import assert from 'node:assert';
import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { build, open, type ResolvedConfig, STATE_DIR, search } from 'sensemaking';
import { writeModel } from '../lib/model.ts';
import { forEachStore, type openTreeForStore, type ParityStoreName, withTreeForStore } from '../lib/stores.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

type Store = Awaited<ReturnType<typeof openTreeForStore>>['store'];

interface LifecycleSnapshot {
  frontmatter: Array<{ path: string; title: string; mtime: number; size: number }>;
  content: Array<{ path: string; text: string }>;
  links: Array<{ src: string; target: string; dst: string | null; embed: number }>;
  tags: Array<{ path: string; tag: string }>;
  sections: Array<{ path: string; heading: string; level: number }>;
}

interface PersistentSnapshot {
  meta: Array<{ key: string; value: string }>;
  columns: string[];
  frontmatter: Array<{ path: string; parseError: string | null }>;
  content: Array<{ path: string; text: string }>;
  indexedSources: Array<{ path: string; text: string }>;
}

async function rows<T>(store: Store, sql: string): Promise<T[]> {
  return (await (await store.prepare(sql)).all()) as T[];
}

async function snapshot(store: Store): Promise<LifecycleSnapshot> {
  const frontmatter = await rows<{ path: string; title: string; _mtime: number; _size: number }>(store, 'SELECT "path", title, "_mtime", "_size" FROM frontmatter ORDER BY "path"');
  const content = await rows<{ path: string; text: string }>(store, 'SELECT "path", text FROM content ORDER BY "path"');
  const links = await rows<{ src: string; target: string; dst: string | null; embed: number }>(store, 'SELECT src, target, dst, embed FROM links ORDER BY src, target, embed');
  const tags = await rows<{ path: string; tag: string }>(store, 'SELECT "path", tag FROM tags ORDER BY "path", tag');
  const sections = await rows<{ path: string; heading: string; level: number }>(store, 'SELECT "path", heading, level FROM sections ORDER BY "path", idx');
  return {
    frontmatter: frontmatter.map((row) => ({ path: row.path, title: row.title, mtime: Number(row._mtime), size: Number(row._size) })),
    content,
    links: links.map((row) => ({ ...row, embed: Number(row.embed) })),
    tags,
    sections: sections.map((row) => ({ ...row, level: Number(row.level) })),
  };
}

async function persistentSnapshot(cfg: ResolvedConfig): Promise<PersistentSnapshot> {
  const opened = await open(cfg, { build: false });
  try {
    return {
      meta: await rows(opened.store, 'SELECT key, value FROM meta ORDER BY key'),
      columns: await opened.store.docs.columns(),
      frontmatter: await rows(opened.store, 'SELECT "path", "_parse_error" AS parseError FROM frontmatter ORDER BY "path"'),
      content: await rows(opened.store, 'SELECT "path", text FROM content ORDER BY "path"'),
      indexedSources: await rows(opened.store, 'SELECT "path", text FROM indexed_sources ORDER BY "path"'),
    };
  } finally {
    await opened.store.close();
  }
}

async function presetMembership(store: Store): Promise<Array<{ path: string; preset: string }>> {
  return rows<{ path: string; preset: string }>(store, 'SELECT "path", preset FROM preset_files ORDER BY preset, "path"');
}

async function rankScores(store: Store): Promise<Map<string, number>> {
  const rankRows = await rows<{ path: string; rank: number | null }>(store, 'SELECT "path", "_rank" AS rank FROM frontmatter');
  for (const row of rankRows) {
    if (typeof row.rank !== 'number' || !Number.isFinite(row.rank)) throw new Error(`missing finite rank for ${row.path}: ${row.rank}`);
  }
  return new Map(rankRows.map((row) => [row.path, row.rank as number]));
}

function setMtime(baseDir: string, path: string, mtime: number): void {
  utimesSync(join(baseDir, path), mtime / 1000, mtime / 1000);
}

function fileSize(baseDir: string, path: string): number {
  return statSync(join(baseDir, path)).size;
}

function initialTree(): { baseDir: string; aMtime: number; bMtime: number } {
  const baseDir = tmpTree();
  const aMtime = 4102444800000;
  const bMtime = aMtime + 1000;
  writeNote(baseDir, 'a.md', { frontmatter: { title: 'Alpha', tags: ['old'] }, body: '# Keep\n\nSee [[b]] and #old-inline.' });
  writeNote(baseDir, 'b.md', { frontmatter: { title: 'Beta', tags: ['b-tag'] }, body: '## Beta section\n\nB body links back to [[a]].' });
  setMtime(baseDir, 'a.md', aMtime);
  setMtime(baseDir, 'b.md', bMtime);
  return { baseDir, aMtime, bMtime };
}

describe('store lifecycle: cold, no-op, edit, add, delete', () => {
  it('serves lexical searches through existing-only observational handles', async () => {
    await forEachStore(async (store) => {
      const rootDir = tmpTree();
      const configDir = tmpTree();
      writeNote(rootDir, 'a.md', { body: 'readonly lexical candidate' });
      const cfg: ResolvedConfig = {
        version: 5,
        store,
        presets: { default: { include: ['**/*.md'], signals: { words: 1 } } },
        queries: {},
        rootDir,
        configDir,
        baseDir: rootDir,
        configPath: join(configDir, 'sense.config.json'),
      };
      await build(cfg);
      const before = await persistentSnapshot(cfg);

      const observational = await open(cfg, { build: false });
      try {
        const found = await search(observational.store, cfg, 'candidate');
        assert.deepEqual(
          found.map((row) => row.path),
          ['a.md'],
          `${store}: observational lexical search failed`
        );
      } finally {
        await observational.store.close();
      }
      assert.deepEqual(await persistentSnapshot(cfg), before, `${store}: observational search changed persistent index state`);
    });
  });

  it('reports a missing DuckDB FTS artifact as not ready and rebuilds it', async () => {
    const rootDir = tmpTree();
    const configDir = tmpTree();
    writeNote(rootDir, 'a.md', { body: 'durable lexical artifact' });
    const cfg: ResolvedConfig = {
      version: 5,
      store: 'duckdb',
      presets: { default: { include: ['**/*.md'], signals: { words: 1 } } },
      queries: {},
      rootDir,
      configDir,
      baseDir: rootDir,
      configPath: join(configDir, 'sense.config.json'),
    };
    const writable = await open(cfg);
    try {
      await writable.store.exec('DROP SCHEMA fts_main_content CASCADE');
    } finally {
      await writable.store.close();
    }

    const missing = await open(cfg, { build: false });
    try {
      await assert.rejects(
        () => search(missing.store, cfg, 'artifact'),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, 'INDEX_NOT_READY');
          assert.match((err as Error).message, /artifact is missing/);
          return true;
        }
      );
    } finally {
      await missing.store.close();
    }

    await build(cfg);
    const recovered = await open(cfg, { build: false });
    try {
      assert.deepEqual(
        (await search(recovered.store, cfg, 'artifact')).map((row) => row.path),
        ['a.md']
      );
    } finally {
      await recovered.store.close();
    }
  });

  it('fully recovers a partially committed feature invalidation after config reverts', async () => {
    const rootDir = tmpTree();
    const configDir = tmpTree();
    const configPath = join(configDir, 'sense.config.json');
    writeNote(rootDir, 'a.md', { frontmatter: { tags: ['durable-tag'] }, body: '# Durable heading\n\nunchanged source' });
    const sourceMtime = statSync(join(rootDir, 'a.md')).mtimeMs;
    const cfg: ResolvedConfig = { version: 5, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {}, rootDir, configDir, baseDir: rootDir, configPath };

    const initial = await open(cfg);
    try {
      await initial.store.exec(`CREATE TRIGGER fail_tag_invalidation BEFORE DELETE ON tags BEGIN SELECT RAISE(FAIL, 'forced invalidation failure'); END`);
    } finally {
      await initial.store.close();
    }

    // sections invalidates and commits before tags reaches this trigger. Reverting to cfg makes
    // the durable signature match again, but the derived section row is still gone.
    const withoutSectionsOrTags: ResolvedConfig = { ...cfg, features: { sections: false, tags: false } };
    await assert.rejects(() => open(withoutSectionsOrTags), /forced invalidation failure/);

    const native = new DatabaseSync(join(configDir, STATE_DIR, 'cache.db'));
    try {
      assert.equal((native.prepare('SELECT COUNT(*) AS n FROM sections').get() as { n: number }).n, 0, 'the fixture must commit section invalidation before tags fails');
      assert.equal((native.prepare("SELECT value FROM meta WHERE key = 'core_ready'").get() as { value: string }).value, '0');
      native.exec('DROP TRIGGER fail_tag_invalidation');
    } finally {
      native.close();
    }

    const retried = await open(cfg);
    try {
      assert.deepEqual(await rows(retried.store, 'SELECT "path", heading FROM sections'), [{ path: 'a.md', heading: 'Durable heading' }]);
      assert.deepEqual(await rows(retried.store, 'SELECT "path", tag FROM tags'), [{ path: 'a.md', tag: 'durable-tag' }]);
      assert.equal(statSync(join(rootDir, 'a.md')).mtimeMs, sourceMtime, 'the retry proof must not depend on a source stamp change');
    } finally {
      await retried.store.close();
    }
  });

  it('clears a disabled feature when retrying the same failed config', async () => {
    const rootDir = tmpTree();
    const configDir = tmpTree();
    const configPath = join(configDir, 'sense.config.json');
    writeNote(rootDir, 'a.md', { frontmatter: { tags: ['must-clear'] }, body: 'unchanged source' });
    const sourceMtime = statSync(join(rootDir, 'a.md')).mtimeMs;
    const cfg: ResolvedConfig = { version: 5, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {}, rootDir, configDir, baseDir: rootDir, configPath };

    const initial = await open(cfg);
    try {
      await initial.store.exec(`CREATE TRIGGER fail_tag_invalidation BEFORE DELETE ON tags BEGIN SELECT RAISE(FAIL, 'forced invalidation failure'); END`);
    } finally {
      await initial.store.close();
    }

    const withoutTags: ResolvedConfig = { ...cfg, features: { tags: false } };
    await assert.rejects(() => open(withoutTags), /forced invalidation failure/);
    const native = new DatabaseSync(join(configDir, STATE_DIR, 'cache.db'));
    try {
      assert.equal((native.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n, 1);
      native.exec('DROP TRIGGER fail_tag_invalidation');
    } finally {
      native.close();
    }

    const retried = await open(withoutTags);
    try {
      assert.deepEqual(await rows(retried.store, 'SELECT "path", tag FROM tags'), []);
      assert.equal(statSync(join(rootDir, 'a.md')).mtimeMs, sourceMtime);
    } finally {
      await retried.store.close();
    }
  });

  it('clears disabled embedding rows while recovering an empty tree', async () => {
    const rootDir = tmpTree();
    const configDir = tmpTree();
    const configPath = join(configDir, 'sense.config.json');
    writeNote(rootDir, 'a.md', { body: 'embedded before recovery' });
    const embedded: ResolvedConfig = {
      version: 5,
      store: 'sqlite',
      presets: { default: { include: ['**/*.md'], signals: { vectors: 1 } } },
      embed: { model: writeModel(), provider: 'static' },
      queries: {},
      rootDir,
      configDir,
      baseDir: rootDir,
      configPath,
    };
    const initial = await open(embedded);
    await initial.store.close();
    unlinkSync(join(rootDir, 'a.md'));

    const native = new DatabaseSync(join(configDir, STATE_DIR, 'cache.db'));
    try {
      native.prepare("UPDATE meta SET value = '0' WHERE key = 'core_ready'").run();
    } finally {
      native.close();
    }

    const withoutEmbed: ResolvedConfig = { version: 5, store: 'sqlite', presets: { default: { include: ['**/*.md'], signals: { words: 1 } } }, queries: {}, rootDir, configDir, baseDir: rootDir, configPath };
    const recovered = await open(withoutEmbed);
    try {
      assert.deepEqual(await rows(recovered.store, 'SELECT "path" FROM frontmatter'), []);
      assert.deepEqual(await rows(recovered.store, 'SELECT "path" FROM embeddings'), []);
    } finally {
      await recovered.store.close();
    }
  });

  it('does not create disabled embedding schema while recovering a never-embedded tree', async () => {
    await forEachStore(async (store) => {
      const rootDir = tmpTree();
      const configDir = tmpTree();
      const configPath = join(configDir, 'sense.config.json');
      writeNote(rootDir, 'a.md', { body: 'never embedded' });
      const cfg: ResolvedConfig = {
        version: 5,
        store,
        presets: { default: { include: ['**/*.md'] } },
        queries: {},
        rootDir,
        configDir,
        baseDir: rootDir,
        configPath,
      };
      const initial = await open(cfg);
      try {
        assert.deepEqual(await rows(initial.store, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'"), []);
        await initial.store.exec("UPDATE meta SET value = '0' WHERE key = 'core_ready'");
      } finally {
        await initial.store.close();
      }

      const recovered = await open(cfg);
      try {
        assert.deepEqual(await rows(recovered.store, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embeddings'"), [], `${store}: recovery created disabled embedding schema`);
      } finally {
        await recovered.store.close();
      }
    });
  });

  it('keeps no-build on the last completed generation until an explicit incremental or forced build', async () => {
    await forEachStore(async (store) => {
      const rootDir = tmpTree();
      const configDir = tmpTree();
      const configPath = join(configDir, 'sense.config.json');
      const configText = JSON.stringify({ version: 5, root: rootDir, store, presets: { default: { include: ['**/*.md'] } }, queries: {} });
      writeFileSync(configPath, configText);
      writeNote(rootDir, 'a.md', { body: 'first indexed generation' });
      const cfg: ResolvedConfig = { version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {}, rootDir, configDir, baseDir: rootDir, configPath };

      await build(cfg);
      writeNote(rootDir, 'a.md', { body: 'second live generation' });
      writeNote(rootDir, 'b.md', { body: 'new live note' });

      const stale = await open(cfg, { build: false });
      try {
        assert.deepEqual(await rows<{ path: string; text: string }>(stale.store, 'SELECT "path", text FROM indexed_sources ORDER BY "path"'), [{ path: 'a.md', text: '---\n\n---\n\nfirst indexed generation\n' }], `${store}: no-build read newer live files`);
      } finally {
        await stale.store.close();
      }

      await build(cfg);
      const fresh = await open(cfg, { build: false });
      try {
        assert.deepEqual(
          (await rows<{ path: string }>(fresh.store, 'SELECT "path" FROM frontmatter ORDER BY "path"')).map((row) => row.path),
          ['a.md', 'b.md'],
          `${store}: incremental build did not publish additions`
        );
      } finally {
        await fresh.store.close();
      }

      const aBeforeForce = readFileSync(join(rootDir, 'a.md'), 'utf8');
      await build(cfg, { force: true });
      assert.equal(readFileSync(join(rootDir, 'a.md'), 'utf8'), aBeforeForce, `${store}: force changed a source note`);
      assert.equal(readFileSync(configPath, 'utf8'), configText, `${store}: force changed its owner config`);
      assert.equal(existsSync(join(rootDir, '.sense')), false, `${store}: config-owned state leaked into the tree root`);
    });
  });

  it('keeps visible rows current across every store', async () => {
    await forEachStore(async (store: ParityStoreName) => {
      const { baseDir, aMtime, bMtime } = initialTree();
      const cold = await withTreeForStore(store, baseDir, async ({ store: s }) => snapshot(s));
      assert.deepEqual(
        cold.frontmatter,
        [
          { path: 'a.md', title: 'Alpha', mtime: aMtime, size: fileSize(baseDir, 'a.md') },
          { path: 'b.md', title: 'Beta', mtime: bMtime, size: fileSize(baseDir, 'b.md') },
        ],
        `${store}: cold frontmatter`
      );
      assert.deepEqual(
        cold.content,
        [
          { path: 'a.md', text: 'Keep See b and #old-inline.' },
          { path: 'b.md', text: 'Beta section B body links back to a.' },
        ],
        `${store}: cold content`
      );
      assert.deepEqual(
        cold.links,
        [
          { src: 'a.md', target: 'b', dst: 'b.md', embed: 0 },
          { src: 'b.md', target: 'a', dst: 'a.md', embed: 0 },
        ],
        `${store}: cold links`
      );
      assert.deepEqual(
        cold.tags,
        [
          { path: 'a.md', tag: 'old' },
          { path: 'a.md', tag: 'old-inline' },
          { path: 'b.md', tag: 'b-tag' },
        ],
        `${store}: cold tags`
      );
      assert.deepEqual(
        cold.sections,
        [
          { path: 'a.md', heading: 'Keep', level: 1 },
          { path: 'b.md', heading: 'Beta section', level: 2 },
        ],
        `${store}: cold sections`
      );

      const noOp = await withTreeForStore(store, baseDir, async ({ store: s }) => snapshot(s));
      assert.deepEqual(noOp, cold, `${store}: no-op reopen changed visible rows`);

      const editMtime = aMtime + 2000;
      writeNote(baseDir, 'a.md', { frontmatter: { title: 'Alpha edited', tags: ['new'] }, body: '# Fresh\n\nNo links remain.' });
      setMtime(baseDir, 'a.md', editMtime);
      const edited = await withTreeForStore(store, baseDir, async ({ store: s }) => snapshot(s));
      assert.deepEqual(
        edited.frontmatter,
        [
          { path: 'a.md', title: 'Alpha edited', mtime: editMtime, size: fileSize(baseDir, 'a.md') },
          { path: 'b.md', title: 'Beta', mtime: bMtime, size: fileSize(baseDir, 'b.md') },
        ],
        `${store}: edited frontmatter`
      );
      assert.deepEqual(
        edited.content,
        [
          { path: 'a.md', text: 'Fresh No links remain.' },
          { path: 'b.md', text: 'Beta section B body links back to a.' },
        ],
        `${store}: edited content`
      );
      assert.deepEqual(edited.links, [{ src: 'b.md', target: 'a', dst: 'a.md', embed: 0 }], `${store}: edited note left a stale link`);
      assert.deepEqual(
        edited.tags,
        [
          { path: 'a.md', tag: 'new' },
          { path: 'b.md', tag: 'b-tag' },
        ],
        `${store}: edited note left stale tags`
      );
      assert.deepEqual(
        edited.sections,
        [
          { path: 'a.md', heading: 'Fresh', level: 1 },
          { path: 'b.md', heading: 'Beta section', level: 2 },
        ],
        `${store}: edited note left stale sections`
      );

      const cMtime = aMtime + 3000;
      writeNote(baseDir, 'c.md', { frontmatter: { title: 'Gamma', tags: ['c-tag'] }, body: '## New section\n\nNew body.' });
      setMtime(baseDir, 'c.md', cMtime);
      const added = await withTreeForStore(store, baseDir, async ({ store: s }) => snapshot(s));
      assert.deepEqual(
        added.frontmatter,
        [
          { path: 'a.md', title: 'Alpha edited', mtime: editMtime, size: fileSize(baseDir, 'a.md') },
          { path: 'b.md', title: 'Beta', mtime: bMtime, size: fileSize(baseDir, 'b.md') },
          { path: 'c.md', title: 'Gamma', mtime: cMtime, size: fileSize(baseDir, 'c.md') },
        ],
        `${store}: added frontmatter`
      );
      assert.deepEqual(
        added.content,
        [
          { path: 'a.md', text: 'Fresh No links remain.' },
          { path: 'b.md', text: 'Beta section B body links back to a.' },
          { path: 'c.md', text: 'New section New body.' },
        ],
        `${store}: added content`
      );
      assert.deepEqual(added.links, [{ src: 'b.md', target: 'a', dst: 'a.md', embed: 0 }], `${store}: added links`);
      assert.deepEqual(
        added.tags,
        [
          { path: 'a.md', tag: 'new' },
          { path: 'b.md', tag: 'b-tag' },
          { path: 'c.md', tag: 'c-tag' },
        ],
        `${store}: added tags`
      );
      assert.deepEqual(
        added.sections,
        [
          { path: 'a.md', heading: 'Fresh', level: 1 },
          { path: 'b.md', heading: 'Beta section', level: 2 },
          { path: 'c.md', heading: 'New section', level: 2 },
        ],
        `${store}: added sections`
      );

      unlinkSync(join(baseDir, 'b.md'));
      const deleted = await withTreeForStore(store, baseDir, async ({ store: s }) => snapshot(s));
      assert.deepEqual(
        deleted.frontmatter,
        [
          { path: 'a.md', title: 'Alpha edited', mtime: editMtime, size: fileSize(baseDir, 'a.md') },
          { path: 'c.md', title: 'Gamma', mtime: cMtime, size: fileSize(baseDir, 'c.md') },
        ],
        `${store}: deleted frontmatter`
      );
      assert.deepEqual(
        deleted.content,
        [
          { path: 'a.md', text: 'Fresh No links remain.' },
          { path: 'c.md', text: 'New section New body.' },
        ],
        `${store}: deleted content`
      );
      assert.deepEqual(deleted.links, [], `${store}: deleted note left stale links`);
      assert.deepEqual(
        deleted.tags,
        [
          { path: 'a.md', tag: 'new' },
          { path: 'c.md', tag: 'c-tag' },
        ],
        `${store}: deleted note left stale tags`
      );
      assert.deepEqual(
        deleted.sections,
        [
          { path: 'a.md', heading: 'Fresh', level: 1 },
          { path: 'c.md', heading: 'New section', level: 2 },
        ],
        `${store}: deleted note left stale sections`
      );
    });
  });

  it('refreshes preset membership across a real reopen', async () => {
    await forEachStore(async (store: ParityStoreName) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { body: 'alpha' });
      writeNote(baseDir, 'b.md', { body: 'beta' });
      const before = await withTreeForStore(store, baseDir, async ({ store: opened }) => presetMembership(opened), { presets: { default: { include: ['a.md'] }, secondary: { include: ['b.md'] } } });
      assert.deepEqual(
        before,
        [
          { path: 'a.md', preset: 'default' },
          { path: 'b.md', preset: 'secondary' },
        ],
        `${store}: initial preset membership`
      );
      const after = await withTreeForStore(store, baseDir, async ({ store: opened }) => presetMembership(opened), { presets: { default: { include: ['**/*.md'] } } });
      assert.deepEqual(
        after,
        [
          { path: 'a.md', preset: 'default' },
          { path: 'b.md', preset: 'default' },
        ],
        `${store}: changed preset membership must replace stale assignments`
      );
    });
  });

  it('refreshes cycle and dangling rank values after a graph rewrite without asserting tie order', async () => {
    await forEachStore(async (store) => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
      writeNote(baseDir, 'b.md', { body: 'See [[c]].' });
      writeNote(baseDir, 'c.md', { body: 'See [[a]].' });
      setMtime(baseDir, 'a.md', 4102444800000);
      setMtime(baseDir, 'b.md', 4102444800000);
      setMtime(baseDir, 'c.md', 4102444800000);
      const cycle = await withTreeForStore(store, baseDir, async ({ store: opened }) => rankScores(opened));
      assert.deepEqual([...cycle.keys()].sort(), ['a.md', 'b.md', 'c.md'], `${store}: cycle path set`);
      const cycleBound = Math.abs(Math.fround(1 / 3) - 1 / 3) + Number.EPSILON;
      // The bound covers IEEE Float32 storage rounding plus JS arithmetic roundoff, not rank or tie tolerance.
      for (const path of ['a.md', 'b.md', 'c.md']) assert.ok(Math.abs((cycle.get(path) as number) - 1 / 3) <= cycleBound, `${store}: cycle rank ${path}=${cycle.get(path)}`);

      writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
      writeNote(baseDir, 'b.md', { body: 'No outbound links.' });
      writeNote(baseDir, 'c.md', { body: 'No outbound links.' });
      setMtime(baseDir, 'a.md', 4102444801000);
      setMtime(baseDir, 'b.md', 4102444801000);
      setMtime(baseDir, 'c.md', 4102444801000);
      const dangling = await withTreeForStore(store, baseDir, async ({ store: opened }) => rankScores(opened));
      assert.deepEqual([...dangling.keys()].sort(), ['a.md', 'b.md', 'c.md'], `${store}: dangling path set`);
      const total = [...dangling.values()].reduce((sum, rank) => sum + rank, 0);
      const d = 0.85;
      const danglingRank = (2 + d) / (2 * (d + 3));
      const sourceRank = 1 - 2 * danglingRank;
      assert.ok(Math.abs(total - 1) < 1e-6, `${store}: dangling rank total ${total}`);
      assert.ok(Math.abs((dangling.get('a.md') as number) - sourceRank) < 1e-3, `${store}: source rank refreshed`);
      assert.ok(Math.abs((dangling.get('b.md') as number) - danglingRank) < 1e-3, `${store}: first dangling rank refreshed`);
      assert.ok(Math.abs((dangling.get('c.md') as number) - danglingRank) < 1e-3, `${store}: second dangling rank refreshed`);
    });
  });
});
