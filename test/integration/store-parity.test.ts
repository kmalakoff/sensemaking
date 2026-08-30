import assert from 'node:assert';
import type { SenseError } from 'sensemaking';
import { search } from 'sensemaking';
import { relatedNotes } from '../../src/commands/index.ts';
import { writeModel } from '../lib/model.ts';
import { openTreeForStore, STORE_NAMES } from '../lib/stores.ts';
import { CHINESE_SENTENCES, tmpTree, writeNote } from '../lib/tree.ts';

async function docCount(store: Awaited<ReturnType<typeof openTreeForStore>>['store']): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return Number(((await stmt.get()) as { n: number | bigint }).n);
}

// The same fixture tree indexed by both stores; sqlite is the reference implementation
// (principle 1). This slice's duckdb store covers the portable surface only (frontmatter,
// links/backlinks, sections, tags, docCount) -- no lexical/vector search yet, so this file
// asserts parity on exactly that surface.

function fixtureTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', {
    frontmatter: { title: 'Alpha', priority: 5, tags: ['x', 'y'], active: true },
    body: '# Intro\n\nSee [[b]] and [[b]] again, plus an embed ![[b]].\n\n## Details\n\nMore #inline-tag text.',
  });
  writeNote(baseDir, 'b.md', {
    frontmatter: { title: 'Beta', priority: 'high' },
    body: 'target note, linked back to [[a]].',
  });
  writeNote(baseDir, 'c.md', {
    frontmatter: { title: 'Gamma' },
    body: 'unlinked note.',
  });
  return baseDir;
}

describe('store parity: portable surface (sqlite vs duckdb)', () => {
  it('docCount agrees', async () => {
    const baseDir = fixtureTree();
    const results = await Promise.all(STORE_NAMES.map((store) => openTreeForStore(store, baseDir)));
    const counts = await Promise.all(results.map((r) => docCount(r.store)));
    assert.deepEqual(counts, [3, 3]);
    await Promise.all(results.map((r) => r.store.close()));
  });

  it('frontmatter values agree, including mixed-type dynamic columns and has()', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const rows = (await (await s.prepare('SELECT "path", title, priority FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; title: string; priority: unknown }>;
      assert.deepEqual(
        rows.map((r) => [r.path, r.title, String(r.priority)]),
        [
          ['a.md', 'Alpha', '5'],
          ['b.md', 'Beta', 'high'],
          ['c.md', 'Gamma', 'null'],
        ],
        store
      );
      const hasRow = (await (await s.prepare(`SELECT has(tags, 'x') AS hx, has(tags, 'z') AS hz FROM frontmatter WHERE "path" = ?`)).get('a.md')) as { hx: unknown; hz: unknown };
      assert.equal(Number(hasRow.hx), 1, store);
      assert.equal(Number(hasRow.hz), 0, store);
      await s.close();
    }
  });

  it('docs.columns() agrees on the discovered frontmatter keys', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const columns = new Set(await s.docs.columns());
      for (const expected of ['path', 'title', 'priority', 'tags', 'active']) assert.ok(columns.has(expected), `${store} missing column ${expected}`);
      await s.close();
    }
  });

  it('links and backlinks agree (wikilink + embed grain, dedup on second identical link)', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const outbound = (await (await s.prepare('SELECT dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<{ dst: string; embed: number }>;
      assert.deepEqual(
        outbound.map((r) => [r.dst, Number(r.embed)]),
        [
          ['b.md', 0],
          ['b.md', 1],
        ],
        store
      );
      const backlinks = (await (await s.prepare('SELECT DISTINCT src FROM links WHERE dst = ? AND src != dst ORDER BY src')).all('b.md')) as Array<{ src: string }>;
      assert.deepEqual(
        backlinks.map((r) => r.src),
        ['a.md'],
        store
      );
      await s.close();
    }
  });

  it('sections agree', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const sections = (await (await s.prepare('SELECT heading, level FROM sections WHERE "path" = ? ORDER BY idx')).all('a.md')) as Array<{ heading: string; level: number }>;
      assert.deepEqual(
        sections.map((r) => [r.heading, Number(r.level)]),
        [
          ['Intro', 1],
          ['Details', 2],
        ],
        store
      );
      await s.close();
    }
  });

  it('tags agree (frontmatter list + inline #tag)', async () => {
    const baseDir = fixtureTree();
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const tags = (await (await s.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
      assert.deepEqual(
        tags.map((r) => r.tag),
        ['inline-tag', 'x', 'y'],
        store
      );
      await s.close();
    }
  });

  it('rank (_rank) agrees on sign and ordering across the tree', async () => {
    const baseDir = fixtureTree();
    const orders: string[][] = [];
    for (const store of STORE_NAMES) {
      const { store: s } = await openTreeForStore(store, baseDir);
      const rows = (await (await s.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC, "path"')).all()) as Array<{ path: string; _rank: number }>;
      assert.ok(
        rows.every((r) => typeof r._rank === 'number'),
        store
      );
      orders.push(rows.map((r) => r.path));
      await s.close();
    }
    assert.deepEqual(orders[0], orders[1]);
  });
});

// DuckDB composes lexical search from fts BM25 (ranking) and contains() scans (exact
// substring, phrase verification, unspaced scripts) rather than FTS5 -- sqlite stays the
// reference implementation. Ordering is asserted identical only where
// both engines' BM25 must agree (an unambiguous title-vs-body case); where the underlying BM25
// formulas legitimately differ, this asserts set equality plus the top hit and says so inline.
function lexicalFixtureTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'apple.md', { frontmatter: { title: 'Apple Pie' }, body: 'A recipe for apple pie, using six apples in total.' });
  writeNote(baseDir, 'banana.md', { frontmatter: { title: 'Banana Bread' }, body: 'Banana bread needs very ripe bananas.' });
  writeNote(baseDir, 'both.md', { frontmatter: { title: 'Fruit Salad' }, body: 'This salad mixes apple and banana together with grapes.' });
  writeNote(baseDir, 'phrase.md', { frontmatter: { title: 'Astronomy Notes' }, body: 'The stars and planets fill the night sky above us.' });
  writeNote(baseDir, 'no-phrase.md', { frontmatter: { title: 'Space Facts' }, body: 'Distant planets orbit their stars for billions of years.' });
  writeNote(baseDir, 'compound.md', { frontmatter: { title: 'Product Notes' }, body: 'Our new dashboard offers a customer-facing view of billing.' });
  writeNote(baseDir, 'not-compound.md', { frontmatter: { title: 'Team Notes' }, body: 'A customer facing away from the team asked about billing.' });
  // CHINESE_SENTENCES[0] ("...天气非常好...", weather) and [1] carry no shared vocabulary with
  // [2]/[3], so a substring query into one half never spuriously matches the other.
  writeNote(baseDir, 'zh-weather.md', { body: CHINESE_SENTENCES.slice(0, 2).join('\n\n') });
  writeNote(baseDir, 'zh-other.md', { body: CHINESE_SENTENCES.slice(2, 4).join('\n\n') });
  return baseDir;
}

async function searchPaths(store: 'sqlite' | 'duckdb', baseDir: string, terms: string): Promise<string[]> {
  const { store: s, cfg } = await openTreeForStore(store, baseDir);
  try {
    const rows = await search(s, cfg, terms);
    return rows.map((r) => r.path as string);
  } finally {
    await s.close();
  }
}

describe('store parity: lexical search (sqlite vs duckdb, D1)', () => {
  it('a plain term agrees on the top hit and the match set', async () => {
    const baseDir = lexicalFixtureTree();
    const [sqlitePaths, duckdbPaths] = await Promise.all(STORE_NAMES.map((store) => searchPaths(store, baseDir, 'apple')));
    assert.deepEqual(sqlitePaths[0], 'apple.md', 'sqlite');
    assert.deepEqual(duckdbPaths[0], 'apple.md', 'duckdb');
    assert.deepEqual(new Set(sqlitePaths), new Set(duckdbPaths));
  });

  it('a bare multi-term query AND-joins identically: only the doc with every word matches', async () => {
    const baseDir = lexicalFixtureTree();
    const [sqlitePaths, duckdbPaths] = await Promise.all(STORE_NAMES.map((store) => searchPaths(store, baseDir, 'apple banana')));
    assert.deepEqual(sqlitePaths, ['both.md'], 'sqlite');
    assert.deepEqual(duckdbPaths, ['both.md'], 'duckdb');
  });

  // A documented divergence, not a bug: FTS5's tokenizer treats the hyphen as a separator, so
  // its quoted-phrase query matches "customer facing" as two adjacent tokens regardless of the
  // punctuation between them -- both docs qualify. DuckDB's contains() is a literal substring
  // check (principle 1: String.prototype.includes is the cited spec), so only the doc whose raw
  // text holds the hyphen matches. D1 chooses substring semantics deliberately over emulating
  // FTS5's tokenization, so this is the expected shape, not a parity gap to close.
  it('an exact substring (quoted, punctuated): duckdb is stricter than FTS5s token-adjacency', async () => {
    const baseDir = lexicalFixtureTree();
    const [sqlitePaths, duckdbPaths] = await Promise.all(STORE_NAMES.map((store) => searchPaths(store, baseDir, '"customer-facing"')));
    assert.deepEqual(new Set(sqlitePaths), new Set(['compound.md', 'not-compound.md']), 'sqlite: FTS5 phrase-adjacency ignores the hyphen');
    assert.deepEqual(duckdbPaths, ['compound.md'], 'duckdb: contains() requires the literal hyphen');
  });

  it('a quoted phrase requires adjacency identically: the reordered doc is excluded on both sides', async () => {
    const baseDir = lexicalFixtureTree();
    const [sqlitePaths, duckdbPaths] = await Promise.all(STORE_NAMES.map((store) => searchPaths(store, baseDir, '"stars and planets"')));
    assert.deepEqual(sqlitePaths, ['phrase.md'], 'sqlite');
    assert.deepEqual(duckdbPaths, ['phrase.md'], 'duckdb');
  });

  it('a CJK substring query finds the same note on both sides, without word spaces', async () => {
    const baseDir = lexicalFixtureTree();
    const [sqlitePaths, duckdbPaths] = await Promise.all(STORE_NAMES.map((store) => searchPaths(store, baseDir, '天气')));
    assert.deepEqual(sqlitePaths, ['zh-weather.md'], 'sqlite');
    assert.deepEqual(duckdbPaths, ['zh-weather.md'], 'duckdb');
  });

  // FTS5 query syntax duckdb does not interpret (prefix `*`, boolean OR/NOT): sqlite honors it,
  // duckdb rejects it loudly (STORE_CAPABILITY_MISSING) rather than silently answering as a
  // literal-term match -- a declared difference (PRINCIPLES.md #6), not a parity gap.
  it('a prefix query: sqlite honors it, duckdb rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'appl*');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'both.md']), 'sqlite');
    await assert.rejects(searchPaths('duckdb', baseDir, 'appl*'), (err: SenseError) => {
      assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
      assert.match(err.message, /prefix query/);
      return true;
    });
  });

  it('a boolean OR query: sqlite honors it, duckdb rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'apple OR banana');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'banana.md', 'both.md']), 'sqlite');
    await assert.rejects(searchPaths('duckdb', baseDir, 'apple OR banana'), (err: SenseError) => {
      assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
      assert.match(err.message, /boolean operator/);
      return true;
    });
  });
});

// D2: sqlite scans int8+scale BLOBs in a JS loop; duckdb scans native FLOAT[N] arrays with
// array_cosine_similarity in SQL. Both are handed the same vectors (see embed/query.ts's
// toStore), so scores agree up to int8 quantization noise -- rank agreement, not float
// equality. writeModel() is the offline Model2Vec fixture every embed test uses; no network,
// no download.
function semanticFixtureTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { frontmatter: { title: 'Fruit' }, body: 'An apple every day' });
  writeNote(baseDir, 'b.md', { frontmatter: { title: 'Walls' }, body: 'stone walls' });
  return baseDir;
}

// linked.md/backlinker.md are apple-similar AND linked (related excludes them); similar.md is
// apple-similar and unlinked, the case related exists for; unrelated.md shares nothing.
function relatedFixtureTree(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'target.md', { frontmatter: { title: 'Target' }, body: 'An apple every day. See [[linked]].' });
  writeNote(baseDir, 'linked.md', { frontmatter: { title: 'Linked' }, body: 'An apple every day.' });
  writeNote(baseDir, 'backlinker.md', { frontmatter: { title: 'Backlinker' }, body: 'An apple every day. See [[target]].' });
  writeNote(baseDir, 'similar.md', { frontmatter: { title: 'Similar' }, body: 'pomme reference here.' });
  writeNote(baseDir, 'unrelated.md', { frontmatter: { title: 'Unrelated' }, body: 'stone walls only.' });
  return baseDir;
}

describe('store parity: semantic search (sqlite vs duckdb, D2)', () => {
  it('a vector-only query (zero lexical matches) agrees on the top hit and the match set', async () => {
    const baseDir = semanticFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    const [sqliteRows, duckdbRows] = await Promise.all(
      STORE_NAMES.map(async (store) => {
        const { store: s, cfg } = await openTreeForStore(store, baseDir, { embed });
        const rows = (await search(s, cfg, 'pomme')) as Array<{ path: string; via: string }>;
        await s.close();
        return rows;
      })
    );
    assert.equal(sqliteRows[0]?.path, 'a.md', JSON.stringify(sqliteRows));
    assert.equal(duckdbRows[0]?.path, 'a.md', JSON.stringify(duckdbRows));
    assert.ok(
      sqliteRows.every((r) => r.via === 'vector'),
      JSON.stringify(sqliteRows)
    );
    assert.ok(
      duckdbRows.every((r) => r.via === 'vector'),
      JSON.stringify(duckdbRows)
    );
    assert.deepEqual(new Set(sqliteRows.map((r) => r.path)), new Set(duckdbRows.map((r) => r.path)));
  });
});

describe('store parity: related (sqlite vs duckdb, D2)', () => {
  // The worst-case path (cost is target_chunks x stored_chunks): rank agreement is asserted as
  // the top hit plus set equality, not full order, since a tie the int8/float noise can flip
  // either way is a legitimate divergence, not a bug (see the file-level comment above).
  it('agrees on the top hit and the candidate set, excluding linked notes on both sides', async () => {
    const baseDir = relatedFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    const [sqliteRows, duckdbRows] = await Promise.all(
      STORE_NAMES.map(async (store) => {
        const { store: s, cfg } = await openTreeForStore(store, baseDir, { embed });
        const rows = await relatedNotes(s, cfg, 'target.md', {}, 10);
        await s.close();
        return rows;
      })
    );
    assert.ok(sqliteRows.length > 0, JSON.stringify(sqliteRows));
    assert.equal(sqliteRows[0]?.path, duckdbRows[0]?.path, `top hit disagrees: ${JSON.stringify({ sqliteRows, duckdbRows })}`);
    assert.deepEqual(new Set(sqliteRows.map((r) => r.path)), new Set(duckdbRows.map((r) => r.path)));
    assert.ok(
      sqliteRows.every((r) => r.path !== 'linked.md' && r.path !== 'backlinker.md'),
      JSON.stringify(sqliteRows)
    );
  });
});
