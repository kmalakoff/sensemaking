import assert from 'node:assert';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagerank } from '../../../../src/graph/graph.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('reconcile (duckdb)', () => {
  it('dynamic frontmatter columns hold mixed types across files (VARIANT), read back as plain JS values', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { priority: 5, title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { priority: 'high', title: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", priority FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; priority: unknown }>;
    assert.equal(rows[0].priority, BigInt(5));
    assert.equal(rows[1].priority, 'high');
    await store.close();
  });

  it('a vanished file is removed from frontmatter and its feature-owned rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    rmSync(join(baseDir, 'a.md'));
    const second = await duckdbTree(baseDir);
    const fm = await (await second.store.prepare('SELECT "path" FROM frontmatter')).all();
    assert.deepEqual(fm, []);
    const tags = await (await second.store.prepare('SELECT "path" FROM tags')).all();
    assert.deepEqual(tags, []);
    await second.store.close();
  });

  it('a reparsed file keeps its row and updates values in place', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A2"\n---\n\nbody\n');
    const second = await duckdbTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = (await (await second.store.prepare('SELECT title FROM frontmatter WHERE "path" = ?')).get('a.md')) as { title: string };
    assert.equal(row.title, 'A2');
    await second.store.close();
  });

  it('the links feature resolves wikilinks and populates backlinks (row-tuple stale delete, no char(0))', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[b]] again, plus ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
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
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\n---\n\nSee [[c]] only.\n');
    const second = await duckdbTree(baseDir);
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
    const { store } = await duckdbTree(baseDir);
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

  it('several new frontmatter columns discovered in one reconcile all land (duckdbDialect.addColumns joins them into one ALTER)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { fieldA: 1, fieldB: 'x', fieldC: true } });
    writeNote(baseDir, 'b.md', { frontmatter: { fieldD: 2, fieldE: 'y' } });
    const { store } = await duckdbTree(baseDir);
    const row = (await (await store.prepare('SELECT "fieldA", "fieldB", "fieldC", "fieldD", "fieldE" FROM frontmatter WHERE "path" = ?')).get('a.md')) as Record<string, unknown>;
    assert.equal(row.fieldA, BigInt(1));
    assert.equal(row.fieldB, 'x');
    assert.equal(row.fieldC, true);
    assert.equal(row.fieldD, null);
    await store.close();
  });

  it('rank populates frontmatter._rank from the resolved link graph', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; _rank: number | null }>;
    assert.ok(rows.every((r) => typeof r._rank === 'number'));
    await store.close();
  });

  it('a cold build (appender path) puts every dynamic field in its own column and leaves the feature-owned "_rank" column (sitting between core and dynamic columns) alone', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { beta: 7, gamma: 3.5, alpha: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { beta: 8, gamma: 4.5, alpha: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", beta, gamma, alpha, "_rank" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; beta: unknown; gamma: unknown; alpha: unknown; _rank: number }>;
    assert.deepEqual(
      rows.map((r) => [r.path, r.beta, r.gamma, r.alpha]),
      [
        ['a.md', BigInt(7), 3.5, 'A'],
        ['b.md', BigInt(8), 4.5, 'B'],
      ]
    );
    // The oracle: PageRank over two edgeless nodes, computed independently of reconcile's own call
    // -- not the value a misaligned appender would produce by casting a stray dynamic value into this REAL column.
    const expected = pagerank(['a.md', 'b.md'], []);
    for (const r of rows) assert.ok(Math.abs(r._rank - (expected.get(r.path) ?? 0)) < 1e-9, `${r.path}: got ${r._rank}`);
    await store.close();
  });

  it('bigint, non-integer number, string, empty string and null round-trip identically through the appender (cold build) and the bind path (reparse of an existing row)', async () => {
    const frontmatter = { big: 42, num: 3.14, str: 'hello', empty: '', missing: null };
    const columns = ['big', 'num', 'str', 'empty', 'missing'];
    const select = `SELECT ${columns.map((c) => `${c}, variant_typeof(${c}) AS ${c}_t`).join(', ')} FROM frontmatter WHERE "path" = 'a.md'`;

    const coldDir = tmpTree();
    writeNote(coldDir, 'a.md', { frontmatter });
    const cold = await duckdbTree(coldDir);
    const coldRow = (await (await cold.store.prepare(select)).get()) as Record<string, unknown>;
    await cold.store.close();

    const bindDir = tmpTree();
    writeNote(bindDir, 'a.md', { frontmatter: { title: 'seed' } });
    const seeded = await duckdbTree(bindDir);
    await seeded.store.close();
    writeNote(bindDir, 'a.md', { frontmatter });
    const bind = await duckdbTree(bindDir);
    assert.equal(bind.parsed, 1, 'expected a reparse of the existing row, not a fresh add');
    const bindRow = (await (await bind.store.prepare(select)).get()) as Record<string, unknown>;
    await bind.store.close();

    assert.deepEqual(coldRow, bindRow);
  });

  // links is the strongest alignment case: `dst` sits between target_base and embed. An
  // appender ignoring physical order would slide it into `embed`'s slot instead.
  it('a cold build appends links with dst resolved in place, not shifted into embed', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT src, target, target_base, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 0 },
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 1 },
    ]);
    await store.close();
  });

  // The same alignment risk on the path a cold build no longer takes: an incrementally added
  // link still appends with dst an unwritten (NULL) column, resolved afterward by afterReconcile.
  it('an incrementally added link appends with the unwritten middle column (dst) defaulted, not shifted', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'seed.md', { body: 'seed' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { body: 'See [[b]] and ![[b]].' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT src, target, target_base, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 0 },
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 1 },
    ]);
    await store.close();
  });

  // embeddings' unwritten columns are trailing rather than interior, and NULL is what the embed
  // pass looks for to know a chunk still needs a vector.
  it('a cold build appends embedding rows with scale and vector left NULL for the embed pass', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '# One\n\nSome prose.\n\n# Two\n\nMore prose.' });
    const { store } = await openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, embed: { model: 'minishlab/potion-retrieval-32M', provider: 'static' } } as Parameters<typeof openConfig>[0]);
    const rows = (await (await store.prepare('SELECT "path", chunk, start_line, end_line, scale, vector FROM embeddings WHERE "path" = ? ORDER BY chunk')).all('a.md')) as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0, 'expected at least one chunk row');
    for (const [i, row] of rows.entries()) {
      assert.equal(row.path, 'a.md');
      assert.equal(row.chunk, i, 'chunk index must land in its own column');
      assert.equal(row.scale, null);
      assert.equal(row.vector, null);
      assert.ok(typeof row.start_line === 'number' && row.start_line > 0, `start_line: ${String(row.start_line)}`);
      assert.ok((row.end_line as number) >= (row.start_line as number), 'end_line must not be a shifted value');
    }
    await store.close();
  });

  // Every table but frontmatter is statically typed, so the append path must choose appendValue by
  // the column's own type; appendVariant everywhere would make these read back as variants.
  it('appended rows on statically typed tables keep their declared types', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { tags: ['x'] }, body: '# Heading\n\nProse.' });
    const { store } = await duckdbTree(baseDir);
    const section = (await (await store.prepare('SELECT idx, level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ?')).get('a.md')) as Record<string, unknown>;
    for (const key of ['idx', 'level', 'start_line', 'end_line', 'tokens']) assert.equal(typeof section[key], 'number', `${key}: ${typeof section[key]}`);
    assert.equal(section.heading, 'Heading');
    const types = (await (await store.prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sections'")).all()) as Array<{ column_name: string; data_type: string }>;
    for (const t of types) assert.notEqual(t.data_type, 'VARIANT', `sections.${t.column_name} must not be VARIANT`);
    await store.close();
  });

  // The reason links.store does not delete-and-reinsert: a reparse must not reset dst, or every
  // touch looks like an edge change. The added/not-added split has to preserve that.
  it('a reparse upserts links and preserves the resolved dst, while a new path appends', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { frontmatter: { touched: 1 }, body: 'See [[b]].' });
    writeNote(baseDir, 'c.md', { body: 'See [[b]].' });
    const second = await duckdbTree(baseDir);
    const rows = (await (await second.store.prepare('SELECT src, target, dst FROM links ORDER BY src')).all()) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', dst: 'b.md' },
      { src: 'c.md', target: 'b', dst: 'b.md' },
    ]);
    await second.store.close();
  });

  it('a reconcile with both a new and an existing path in one call routes each correctly (appender for the new path, upsert for the existing one), with no duplication', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A1' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B1' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A2' } });
    writeNote(baseDir, 'c.md', { frontmatter: { title: 'C1' } });
    const second = await duckdbTree(baseDir);
    assert.equal(second.parsed, 2);
    const rows = (await (await second.store.prepare('SELECT "path", title FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; title: string }>;
    assert.deepEqual(
      rows.map((r) => [r.path, r.title]),
      [
        ['a.md', 'A2'],
        ['b.md', 'B1'],
        ['c.md', 'C1'],
      ]
    );
    await second.store.close();
  });
});
