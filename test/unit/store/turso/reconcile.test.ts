import assert from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SenseError } from 'sensemaking';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function tursoTree(baseDir: string) {
  return openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\nbody\n`);
}

describe('reconcile (turso)', () => {
  it('dynamic frontmatter columns are untyped and hold their original JS values', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { priority: 5, title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { priority: 'high', title: 'B' } });
    const { store } = await tursoTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", priority FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; priority: unknown }>;
    assert.equal(rows[0].priority, 5);
    assert.equal(rows[1].priority, 'high');
    await store.close();
  });

  it('a vanished file is removed from frontmatter, content, and its feature-owned rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const first = await tursoTree(baseDir);
    await first.store.close();

    rmSync(join(baseDir, 'a.md'));
    const second = await tursoTree(baseDir);
    const fm = await (await second.store.prepare('SELECT "path" FROM frontmatter')).all();
    assert.deepEqual(fm, []);
    const content = await (await second.store.prepare('SELECT "path" FROM content')).all();
    assert.deepEqual(content, []);
    const tags = await (await second.store.prepare('SELECT "path" FROM tags')).all();
    assert.deepEqual(tags, []);
    await second.store.close();
  });

  it('a reparsed file keeps its row and updates values in place', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await tursoTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A2"\n---\n\nbody\n');
    const second = await tursoTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = (await (await second.store.prepare('SELECT title FROM frontmatter WHERE "path" = ?')).get('a.md')) as { title: string };
    assert.equal(row.title, 'A2');
    const contentCount = (await (await second.store.prepare('SELECT COUNT(*) AS n FROM content WHERE "path" = ?')).get('a.md')) as { n: number };
    assert.equal(contentCount.n, 1, 'content is updated in place, not duplicated (delete-then-insert keyed by path)');
    await second.store.close();
  });

  it('the links feature resolves wikilinks and populates backlinks', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[b]] again, plus ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await tursoTree(baseDir);
    const edges = (await (await store.prepare('SELECT src, dst, embed FROM links ORDER BY embed')).all()) as Array<{ src: string; dst: string; embed: number }>;
    assert.deepEqual(
      edges.map((e) => [e.src, e.dst, e.embed]),
      [
        ['a.md', 'b.md', 0],
        ['a.md', 'b.md', 1],
      ]
    );
    await store.close();
  });

  it('re-parsing a linked file with a dropped link removes the stale row without leaving orphans', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    writeNote(baseDir, 'c.md', { body: 'target' });
    const first = await tursoTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\n---\n\nSee [[c]] only.\n');
    const second = await tursoTree(baseDir);
    const targets = (await (await second.store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string }>;
    assert.deepEqual(
      targets.map((t) => t.target),
      ['c']
    );
    await second.store.close();
  });

  it('sections and tags feature hooks populate their tables', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { tags: ['x'] }, body: '# Heading\n\nSome #inline-tag text.' });
    const { store } = await tursoTree(baseDir);
    const sections = (await (await store.prepare('SELECT heading FROM sections WHERE "path" = ?')).all('a.md')) as Array<{ heading: string }>;
    assert.deepEqual(
      sections.map((s) => s.heading),
      ['Heading']
    );
    const tags = (await (await store.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
    assert.deepEqual(
      tags.map((t) => t.tag),
      ['inline-tag', 'x']
    );
    await store.close();
  });

  it('rank populates frontmatter._rank from the resolved link graph', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await tursoTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; _rank: number | null }>;
    assert.ok(rows.every((r) => typeof r._rank === 'number'));
    await store.close();
  });

  it("crossing turso's SELECT result-set column limit fails with a named error, not a raw prepare failure", async () => {
    const baseDir = tmpTree();
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) frontmatter[`k${i}`] = i;
    write(baseDir, 'huge.md', frontmatter);

    await assert.rejects(tursoTree(baseDir), (err: unknown) => {
      assert.ok(err instanceof SenseError, `expected a SenseError, got ${err}`);
      assert.equal((err as SenseError).code, 'COLUMN_LIMIT');
      assert.match((err as Error).message, /2000/);
      assert.match((err as Error).message, /presets.+include/);
      return true;
    });
  });
});
