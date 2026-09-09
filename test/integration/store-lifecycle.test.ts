import assert from 'node:assert';
import { statSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
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
