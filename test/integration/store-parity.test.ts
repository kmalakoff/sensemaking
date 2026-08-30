import assert from 'node:assert';
import type { SenseError } from 'sensemaking';
import { search } from 'sensemaking';
import { mapTree, relatedNotes } from '../../src/commands/index.ts';
import { findPath } from '../../src/graph/traverse.ts';
import { writeModel } from '../lib/model.ts';
import { declaredCapabilities, forEachOfStores, forEachOtherStore, forEachOtherStoreByCapability, forEachStore, forEachStoreByCapability, isMissingDependency, openTreeForStore, type ParityStoreName } from '../lib/stores.ts';
import { CHINESE_SENTENCES, tmpTree, writeNote } from '../lib/tree.ts';

async function docCount(store: Awaited<ReturnType<typeof openTreeForStore>>['store']): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return Number(((await stmt.get()) as { n: number | bigint }).n);
}

async function rankOrder(store: Awaited<ReturnType<typeof openTreeForStore>>['store'], label: string): Promise<string[]> {
  const rows = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC, "path"')).all()) as Array<{ path: string; _rank: number }>;
  assert.ok(
    rows.every((r) => typeof r._rank === 'number'),
    label
  );
  return rows.map((r) => r.path);
}

// The same fixture tree indexed by every store; sqlite is the reference implementation
// (PRINCIPLES: proven-or-verified), every other store is diffed against it.

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

describe('store parity: portable surface (sqlite reference)', () => {
  it('docCount agrees', async () => {
    const baseDir = fixtureTree();
    const { store: sqliteStore } = await openTreeForStore('sqlite', baseDir);
    const sqliteCount = await docCount(sqliteStore);
    assert.equal(sqliteCount, 3, 'sqlite');
    await sqliteStore.close();
    await forEachOtherStore(async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      assert.equal(await docCount(s), sqliteCount, store);
      await s.close();
    });
  });

  it('frontmatter values agree, including mixed-type dynamic columns', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
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
      await s.close();
    });
  });

  it('docs.columns() agrees on the discovered frontmatter keys', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      const columns = new Set(await s.docs.columns());
      for (const expected of ['path', 'title', 'priority', 'tags', 'active']) assert.ok(columns.has(expected), `${store} missing column ${expected}`);
      await s.close();
    });
  });

  it('links and backlinks agree (wikilink + embed grain, dedup on second identical link)', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
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
    });
  });

  it('sections agree', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
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
    });
  });

  it('tags agree (frontmatter list + inline #tag)', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      const tags = (await (await s.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
      assert.deepEqual(
        tags.map((r) => r.tag),
        ['inline-tag', 'x', 'y'],
        store
      );
      await s.close();
    });
  });

  it('rank (_rank) agrees on sign and ordering across the tree', async () => {
    const baseDir = fixtureTree();
    const { store: sqliteStore } = await openTreeForStore('sqlite', baseDir);
    const sqliteOrder = await rankOrder(sqliteStore, 'sqlite');
    await sqliteStore.close();
    await forEachOtherStore(async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      assert.deepEqual(await rankOrder(s, store), sqliteOrder, store);
      await s.close();
    });
  });
});

// has()/basename()/segment() are sense-registered SQL functions (UDFs), not portable contract.
// sqlite and duckdb register them; turso's client cannot register UDFs, so its rejection is asserted as a declared difference (PRINCIPLES: no-silent-modes).
const SQL_FUNCTION_STORE_NAMES: Exclude<ParityStoreName, 'turso'>[] = ['sqlite', 'duckdb'];

describe('store parity: has() (SQL function extra, not portable -- T6)', () => {
  it('agrees on sqlite and duckdb, the stores that register it', async () => {
    const baseDir = fixtureTree();
    await forEachOfStores(SQL_FUNCTION_STORE_NAMES, async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      const hasRow = (await (await s.prepare(`SELECT has(tags, 'x') AS hx, has(tags, 'z') AS hz FROM frontmatter WHERE "path" = ?`)).get('a.md')) as { hx: unknown; hz: unknown };
      assert.equal(Number(hasRow.hx), 1, store);
      assert.equal(Number(hasRow.hz), 0, store);
      await s.close();
    });
  });

  it('turso rejects it: no UDF registration in this client, a declared difference not a gap', async () => {
    const baseDir = fixtureTree();
    await forEachOfStores(['turso'], async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      await assert.rejects(s.prepare(`SELECT has(tags, 'x') AS hx FROM frontmatter WHERE "path" = ?`), /no such function: has/, store);
      await s.close();
    });
  });
});

// DuckDB composes lexical search from fts BM25 (ranking) plus contains() scans (exact substring, phrase verification, unspaced scripts), not FTS5; sqlite stays the reference.
// Ordering is asserted only where both engines' BM25 must agree; where BM25 formulas legitimately differ, this asserts set equality plus the top hit instead.
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
  // "telescope" and CHINESE_SENTENCES[4] (Beijing) appear in no other note, so neither half of a mixed query can match anything but these three.
  // mixed.md also doubles as the both-halves note for the word-plus-phrase case below; phrase.md holds "night sky" without a telescope, telescope-only.md the word without the phrase.
  writeNote(baseDir, 'mixed.md', { body: `A telescope points at the night sky.\n\n${CHINESE_SENTENCES[4]}` });
  writeNote(baseDir, 'telescope-only.md', { body: 'A telescope points upward.' });
  writeNote(baseDir, 'zh-beijing.md', { body: CHINESE_SENTENCES[4] });
  return baseDir;
}

async function searchPaths(store: ParityStoreName, baseDir: string, terms: string): Promise<string[]> {
  const { store: s, cfg } = await openTreeForStore(store, baseDir);
  try {
    const rows = await search(s, cfg, terms);
    return rows.map((r) => r.path as string);
  } finally {
    await s.close();
  }
}

// Declared lexical divergences, keyed by case then store: a store not listed must match sqlite's result exactly.
// A listed store states its own expected result and reason instead of inheriting sqlite's by position.
const LEXICAL_DIVERGENCES: Partial<Record<string, Partial<Record<ParityStoreName, { paths: string[]; reason: string }>>>> = {
  'exact substring (quoted, punctuated)': {
    duckdb: { paths: ['compound.md'], reason: 'contains() requires the literal hyphen; FTS5 phrase-adjacency ignores it' },
  },
};

// A store lacking a capability must fail loudly with STORE_CAPABILITY_MISSING naming it (PRINCIPLES: no-silent-modes); shared by every capability-gated case below.
// A missing-dependency error is left to propagate to the loop's own skip instead, since a store that cannot open cannot be asked to reject a query.
async function assertCapabilityMissing(store: ParityStoreName, promise: Promise<unknown>, messagePattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    if (isMissingDependency(err)) throw err;
    assert.equal((err as SenseError).code, 'STORE_CAPABILITY_MISSING', store);
    assert.match((err as SenseError).message, messagePattern);
    return;
  }
  assert.fail(`${store} should reject this query`);
}

// The Store contract every engine owes, asserted once per store: a new store gets this coverage
// by joining STORE_NAMES, and its unit twin keeps only what that engine alone does.
// A bulk build crosses turso's FTS_REBUILD_THRESHOLD, so reconcile drops the index, inserts, and
// rebuilds it. Ranking is what detects a failed rebuild: turso's fts_match still returns the right
// rows by scanning when no index exists, and fts_score then returns 0 for every one, so a search
// answers correctly in meaningless order. Asserting matches alone cannot see that.
describe('store parity: a bulk build keeps its ranking (every store)', () => {
  it('a title hit outranks a body-only hit across a tree large enough to rebuild the index', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < 300; i++) writeNote(baseDir, `filler${i}.md`, { frontmatter: { title: `Filler ${i}` }, body: `unrelated padding ${i}` });
    writeNote(baseDir, 'title-hit.md', { frontmatter: { title: 'Sarsaparilla' }, body: 'nothing else relevant here' });
    writeNote(baseDir, 'body-hit.md', { frontmatter: { title: 'Unrelated' }, body: 'a sarsaparilla is mentioned only in passing here' });

    await forEachStoreByCapability(
      'lexical',
      async (name) => {
        const { store, cfg } = await openTreeForStore(name, baseDir);
        const hits = await store.lexical.query('sarsaparilla', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
        assert.deepEqual(
          hits.map((h) => h.path),
          ['title-hit.md', 'body-hit.md'],
          `${name}: field weighting must survive a bulk build; equal ordering means scoring collapsed`
        );
        await store.close();
      },
      async () => {}
    );
  });
});

describe('store parity: the Store contract (every store)', () => {
  it("name matches the registry key, and capabilities match the store module's own declaration", async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    await forEachStore(async (name) => {
      const { store } = await openTreeForStore(name, baseDir);
      assert.equal(store.name, name);
      assert.deepEqual(new Set(store.capabilities), declaredCapabilities(name), name);
      await store.close();
    });
  });

  it('docs.columns() returns frontmatter column names, including dynamic keys', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    await forEachStore(async (name) => {
      const { store } = await openTreeForStore(name, baseDir);
      const columns = await store.docs.columns();
      for (const expected of ['path', 'title', 'tags']) assert.ok(columns.includes(expected), `${name}: expected '${expected}' among ${columns.join(', ')}`);
      await store.close();
    });
  });

  it('raw.prepare() streams rows through its async iterator', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    await forEachStore(async (name) => {
      const { store } = await openTreeForStore(name, baseDir);
      const stmt = await store.raw.prepare('SELECT "path" FROM frontmatter ORDER BY "path"');
      const rows: unknown[] = [];
      for await (const row of stmt.iterate()) rows.push(row);
      assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }], name);
      await store.close();
    });
  });

  // 2^53 + 9: past the safe-integer range, so a store that hands back a Number has already lost
  // digits by the time the assertion runs.
  it('raw.prepare() reads int64 values past 2^53 as BigInt', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    await forEachStore(async (name) => {
      const { store } = await openTreeForStore(name, baseDir);
      const stmt = await store.raw.prepare('SELECT 9007199254740993 AS big');
      const rows: Array<{ big: unknown }> = [];
      for await (const row of stmt.iterate()) rows.push(row as { big: unknown });
      assert.equal(rows.length, 1, name);
      assert.equal(typeof rows[0].big, 'bigint', name);
      assert.equal(rows[0].big, BigInt('9007199254740993'), name);
      await store.close();
    });
  });
});

describe('store parity: lexical search (sqlite reference, D1)', () => {
  it('a plain term agrees on the top hit and the match set', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'apple');
    assert.deepEqual(sqlitePaths[0], 'apple.md', 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => {
        const paths = await searchPaths(store, baseDir, 'apple');
        assert.deepEqual(paths[0], sqlitePaths[0], store);
        assert.deepEqual(new Set(paths), new Set(sqlitePaths), store);
      },
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'apple'), /lexical/)
    );
  });

  it('a bare multi-term query AND-joins identically: only the doc with every word matches', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'apple banana');
    assert.deepEqual(sqlitePaths, ['both.md'], 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'apple banana'), sqlitePaths, store),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'apple banana'), /lexical/)
    );
  });

  // FTS5 tokenizes the hyphen as a separator, so its quoted-phrase query matches "customer facing" as two adjacent tokens regardless of punctuation -- both docs qualify.
  // DuckDB's contains() is a literal substring check (PRINCIPLES: proven-or-verified, String.prototype.includes), so only the doc with the literal hyphen matches; see LEXICAL_DIVERGENCES.
  it('an exact substring (quoted, punctuated): a declared divergence, not a parity gap', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, '"customer-facing"');
    assert.deepEqual(new Set(sqlitePaths), new Set(['compound.md', 'not-compound.md']), 'sqlite: FTS5 phrase-adjacency ignores the hyphen');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => {
        const paths = await searchPaths(store, baseDir, '"customer-facing"');
        const divergence = LEXICAL_DIVERGENCES['exact substring (quoted, punctuated)']?.[store];
        if (divergence) assert.deepEqual(paths, divergence.paths, `${store}: ${divergence.reason}`);
        else assert.deepEqual(new Set(paths), new Set(sqlitePaths), store);
      },
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, '"customer-facing"'), /lexical/)
    );
  });

  it('a quoted phrase requires adjacency identically: the reordered doc is excluded on both sides', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, '"stars and planets"');
    assert.deepEqual(sqlitePaths, ['phrase.md'], 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => assert.deepEqual(await searchPaths(store, baseDir, '"stars and planets"'), sqlitePaths, store),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, '"stars and planets"'), /lexical/)
    );
  });

  it('a CJK substring query finds the same note on both sides, without word spaces', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, '天气');
    assert.deepEqual(sqlitePaths, ['zh-weather.md'], 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => assert.deepEqual(await searchPaths(store, baseDir, '天气'), sqlitePaths, store),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, '天气'), /lexical/)
    );
  });

  // A mixed-script query ANDs two engine mechanisms per store (sqlite: FTS5 terms + `_seg` grapheme phrases; duckdb: BM25 + contains(); turso: two FTS indexes).
  // Getting each half right but the conjunction wrong is silent (ranking goes flat, result set stays correct), so this asserts both halves narrow to the one matching note.
  it('a mixed ascii + CJK query ANDs both halves: only the note holding both matches', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'telescope 北京');
    assert.deepEqual(sqlitePaths, ['mixed.md'], 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'telescope 北京'), sqlitePaths, store),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'telescope 北京'), /lexical/)
    );
  });

  it('a bare word plus a quoted phrase ANDs both: the note holding only the phrase is excluded', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'telescope "night sky"');
    assert.deepEqual(sqlitePaths, ['mixed.md'], 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'telescope "night sky"'), sqlitePaths, store),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'telescope "night sky"'), /lexical/)
    );
  });

  // sqlite honors FTS5-only syntax (prefix `*`, boolean OR/NOT); every other store rejects it loudly with STORE_CAPABILITY_MISSING instead of a silent literal-term match (PRINCIPLES: no-silent-modes).
  // duckdb has "lexical" but not FTS5 syntax, so it names the operator; turso has no "lexical" at all, so it names the missing capability instead.
  it('a prefix query: sqlite honors it, every other store rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'appl*');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'both.md']), 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'appl*'), /prefix query/),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'appl*'), /lexical/)
    );
  });

  it('a boolean OR query: sqlite honors it, every other store rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'apple OR banana');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'banana.md', 'both.md']), 'sqlite');
    await forEachOtherStoreByCapability(
      'lexical',
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'apple OR banana'), /boolean operator/),
      (store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'apple OR banana'), /lexical/)
    );
  });
});

// D2: sqlite scans int8+scale BLOBs in a JS loop; duckdb scans native FLOAT[N] arrays via array_cosine_similarity in SQL, both handed the same vectors (embed/query.ts's toStore).
// Scores agree only up to int8 quantization noise (rank agreement, not float equality). writeModel() is the offline Model2Vec fixture every embed test uses; no network.
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

async function semanticPaths(store: ParityStoreName, baseDir: string, embed: { model: string; provider: 'static' }, terms: string): Promise<Array<{ path: string; via: string }>> {
  const { store: s, cfg } = await openTreeForStore(store, baseDir, { embed });
  try {
    return (await search(s, cfg, terms)) as Array<{ path: string; via: string }>;
  } finally {
    await s.close();
  }
}

describe('store parity: semantic search (sqlite reference, D2)', () => {
  it('a vector-only query (zero lexical matches) agrees on the top hit and the match set', async () => {
    const baseDir = semanticFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    const sqliteRows = await semanticPaths('sqlite', baseDir, embed, 'pomme');
    assert.equal(sqliteRows[0]?.path, 'a.md', JSON.stringify(sqliteRows));
    assert.ok(
      sqliteRows.every((r) => r.via === 'vector'),
      JSON.stringify(sqliteRows)
    );
    await forEachOtherStoreByCapability(
      'vectors',
      async (store) => {
        const rows = await semanticPaths(store, baseDir, embed, 'pomme');
        assert.equal(rows[0]?.path, 'a.md', JSON.stringify(rows));
        assert.ok(
          rows.every((r) => r.via === 'vector'),
          JSON.stringify(rows)
        );
        assert.deepEqual(new Set(rows.map((r) => r.path)), new Set(sqliteRows.map((r) => r.path)), store);
      },
      (store) => assertCapabilityMissing(store, semanticPaths(store, baseDir, embed, 'pomme'), /vectors/)
    );
  });
});

async function relatedPaths(store: ParityStoreName, baseDir: string, embed: { model: string; provider: 'static' }, target: string) {
  const { store: s, cfg } = await openTreeForStore(store, baseDir, { embed });
  try {
    return await relatedNotes(s, cfg, target, {}, 10);
  } finally {
    await s.close();
  }
}

describe('store parity: related (sqlite reference, D2)', () => {
  // Worst-case path (cost is target_chunks x stored_chunks): rank agreement is asserted as top hit plus set equality, not full order.
  // A tie the int8/float noise can flip either way is a legitimate divergence, not a bug (see D2 comment above).
  it('agrees on the top hit and the candidate set, excluding linked notes on both sides', async () => {
    const baseDir = relatedFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    const sqliteRows = await relatedPaths('sqlite', baseDir, embed, 'target.md');
    assert.ok(sqliteRows.length > 0, JSON.stringify(sqliteRows));
    assert.ok(
      sqliteRows.every((r) => r.path !== 'linked.md' && r.path !== 'backlinker.md'),
      JSON.stringify(sqliteRows)
    );
    await forEachOtherStoreByCapability(
      'vectors',
      async (store) => {
        const rows = await relatedPaths(store, baseDir, embed, 'target.md');
        assert.equal(rows[0]?.path, sqliteRows[0]?.path, `top hit disagrees: ${JSON.stringify({ sqliteRows, rows })}`);
        assert.deepEqual(new Set(rows.map((r) => r.path)), new Set(sqliteRows.map((r) => r.path)), store);
      },
      (store) => assertCapabilityMissing(store, relatedPaths(store, baseDir, embed, 'target.md'), /vectors/)
    );
  });
});

// map, scoped search, and findPath each materialize a path set into a temp table and filter against it.
// A whole-tree scope must change nothing; a narrowed scope must narrow identically on both stores.
describe('store parity: scoped commands (sqlite reference)', () => {
  it('mapTree agrees with a whole-tree scope and with a narrowed include', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
      const { store: s, cfg } = await openTreeForStore(store, baseDir);
      const whole = await mapTree(s, cfg);
      assert.equal(whole.docs.count, 3, store);
      assert.equal(whole.hubs.length, 3, store);
      assert.equal(whole.recent.length, 3, store);
      // Field types are classified from decoded values, not engine typeof(), so the label is identical on every store.
      // priority is mixed (number in a.md, string in b.md, absent in c.md); tags is a JSON-stringified array; active is a boolean stored as an integer.
      const fieldTypes = Object.fromEntries(whole.fields.map((f) => [f.field, f.type]));
      assert.deepEqual(fieldTypes, { title: 'text', priority: 'integer,text', tags: 'text', active: 'integer' }, store);
      const narrowed = await mapTree(s, cfg, { include: ['a.md', 'b.md'] });
      assert.equal(narrowed.docs.count, 2, store);
      assert.equal(narrowed.hubs.length, 2, store);
      assert.equal(narrowed.recent.length, 2, store);
      await s.close();
    });
  });

  it('search agrees when the scope is narrowed with an include override', async () => {
    const baseDir = fixtureTree();
    await forEachStoreByCapability(
      'lexical',
      async (store) => {
        const { store: s, cfg } = await openTreeForStore(store, baseDir);
        // a.md matches only via the link signal (b.md, a word hit, links back to it).
        const full = (await search(s, cfg, 'note')).map((r) => r.path as string);
        assert.deepEqual(new Set(full), new Set(['a.md', 'b.md', 'c.md']), store);
        const scoped = (await search(s, cfg, 'note', { include: ['c.md'] })).map((r) => r.path as string);
        assert.deepEqual(scoped, ['c.md'], store);
        await s.close();
      },
      async (store) => {
        const { store: s, cfg } = await openTreeForStore(store, baseDir);
        await assertCapabilityMissing(store, search(s, cfg, 'note'), /lexical/);
        await s.close();
      }
    );
  });

  it('findPath agrees, with and without an allowed scope', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[[b]]' });
    writeNote(baseDir, 'b.md', { body: '[[c]]' });
    writeNote(baseDir, 'c.md', { body: 'end.' });
    await forEachStore(async (store) => {
      const { store: s } = await openTreeForStore(store, baseDir);
      assert.deepEqual(await findPath(s, 'a.md', 'c.md'), ['a.md', 'b.md', 'c.md'], store);
      assert.deepEqual(await findPath(s, 'a.md', 'c.md', { allowed: new Set(['a.md', 'b.md', 'c.md']) }), ['a.md', 'b.md', 'c.md'], store);
      assert.equal(await findPath(s, 'a.md', 'c.md', { allowed: new Set(['a.md', 'c.md']) }), null, store);
      await s.close();
    });
  });
});
