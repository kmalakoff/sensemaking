import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SenseError } from 'sensemaking';
import { search } from 'sensemaking';
import { mapTree, relatedNotes } from '../../src/commands/index.ts';
import { SenseError as StoreSenseError } from '../../src/errors.ts';
import { findPath } from '../../src/graph/traverse.ts';
import { writeModel } from '../lib/model.ts';
import { declaredCapabilities, forEachOfStores, forEachOtherStore, forEachStore, forEachStoreByCapability, isMissingDependency, type openTreeForStore, type ParityStoreName, withTreeForStore } from '../lib/stores.ts';
import { CHINESE_SENTENCES, tmpTree, writeNote } from '../lib/tree.ts';

type SearchResult = { path: string; snippets?: string[]; lines?: string | null };

async function docCount(store: Awaited<ReturnType<typeof openTreeForStore>>['store']): Promise<number> {
  const stmt = await store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
  return Number(((await stmt.get()) as { n: number | bigint }).n);
}

async function rankRows(store: Awaited<ReturnType<typeof openTreeForStore>>['store'], label: string): Promise<Array<{ path: string; _rank: number }>> {
  const rows = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC, "path"')).all()) as Array<{ path: string; _rank: number }>;
  assert.ok(
    rows.every((r) => Number.isFinite(r._rank) && r._rank > 0),
    label
  );
  return rows;
}

// Shared fixtures assert documented properties directly; engine-specific differences stay explicit.

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
  it('docCount matches the authored tree', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => withTreeForStore(store, baseDir, async ({ store: s }) => assert.equal(await docCount(s), 3, store)));
  });

  it('frontmatter values agree, including mixed-type dynamic columns', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
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
      })
    );
  });

  it('docs.columns() agrees on the discovered frontmatter keys', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const columns = new Set(await s.docs.columns());
        for (const expected of ['path', 'title', 'priority', 'tags', 'active']) assert.ok(columns.has(expected), `${store} missing column ${expected}`);
      })
    );
  });

  it('links and backlinks agree (wikilink + embed grain, dedup on second identical link)', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
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
      })
    );
  });

  it('sections agree', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const sections = (await (await s.prepare('SELECT heading, level FROM sections WHERE "path" = ? ORDER BY idx')).all('a.md')) as Array<{ heading: string; level: number }>;
        assert.deepEqual(
          sections.map((r) => [r.heading, Number(r.level)]),
          [
            ['Intro', 1],
            ['Details', 2],
          ],
          store
        );
      })
    );
  });

  it('tags agree (frontmatter list + inline #tag)', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const tags = (await (await s.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
        assert.deepEqual(
          tags.map((r) => r.tag),
          ['inline-tag', 'x', 'y'],
          store
        );
      })
    );
  });

  it('rank (_rank) satisfies the authored graph before comparing store order', async () => {
    const baseDir = fixtureTree();
    const sqliteOrder = await withTreeForStore('sqlite', baseDir, async ({ store }) => {
      const rows = await rankRows(store, 'sqlite');
      const ranks = new Map(rows.map((row) => [row.path, row._rank]));
      assert.ok(Math.abs((ranks.get('a.md') ?? 0) - (ranks.get('b.md') ?? 0)) < 1e-12, 'sqlite: reciprocal linked notes have equal rank');
      assert.ok((ranks.get('a.md') ?? 0) > (ranks.get('c.md') ?? 0), 'sqlite: linked notes outrank the isolated note');
      return rows.map((row) => row.path);
    });
    assert.deepEqual(new Set(sqliteOrder), new Set(['a.md', 'b.md', 'c.md']), 'sqlite: every authored node gets a rank');
    await forEachOtherStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const rows = await rankRows(s, store);
        const ranks = new Map(rows.map((row) => [row.path, row._rank]));
        assert.ok(Math.abs((ranks.get('a.md') ?? 0) - (ranks.get('b.md') ?? 0)) < 1e-12, `${store}: reciprocal linked notes have equal rank`);
        assert.ok((ranks.get('a.md') ?? 0) > (ranks.get('c.md') ?? 0), `${store}: linked notes outrank the isolated note`);
        assert.deepEqual(
          rows.map((row) => row.path),
          sqliteOrder,
          `${store}: cross-store order`
        );
      })
    );
  });

  it('closes each store when the parity callback fails', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) => {
      let captured: Awaited<ReturnType<typeof openTreeForStore>>['store'] | undefined;
      await assert.rejects(
        withTreeForStore(store, baseDir, async ({ store: s }) => {
          captured = s;
          throw new Error('parity callback failure');
        }),
        /parity callback failure/
      );
      assert.ok(captured);
      await assert.rejects(captured.prepare('SELECT 1'));
      await withTreeForStore(store, baseDir, async ({ store: s }) => {
        const rows = (await (await s.prepare('SELECT "path" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string }>;
        assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }], store);
      });
    });
  });
});

describe('store parity: required backend failures', () => {
  it('propagates a missing dependency with store context', async () => {
    const failure = new StoreSenseError('STORE_DEPENDENCY_MISSING', 'native package missing');
    await assert.rejects(
      () =>
        forEachOfStores(['duckdb'], async () => {
          throw failure;
        }),
      (err: unknown) => {
        assert.strictEqual(err, failure);
        assert.strictEqual(failure.code, 'STORE_DEPENDENCY_MISSING');
        assert.strictEqual(failure.message, 'store "duckdb": native package missing');
        return true;
      }
    );
  });
});

// has()/basename() are sense-registered SQL functions: sqlite/duckdb via native UDF registration,
// turso via a SQL-text rewrite into portable expressions (turso/sql-functions.ts) since its client
// cannot register UDFs at all. segment() stays UDF-only (it calls Intl.Segmenter grapheme
// clustering, with no SQL form), so it alone still separates the 'segment' capability --
// see 'segment is declared honestly', below.
describe('store parity: has()/basename() (SQL functions, T6)', () => {
  it('has() agrees on every store', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const hasRow = (await (await s.prepare(`SELECT has(tags, 'x') AS hx, has(tags, 'z') AS hz FROM frontmatter WHERE "path" = ?`)).get('a.md')) as { hx: unknown; hz: unknown };
        assert.equal(Number(hasRow.hx), 1, store);
        assert.equal(Number(hasRow.hz), 0, store);
      })
    );
  });

  it('basename() agrees on every store', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        const row = (await (await s.prepare(`SELECT basename("path") AS full, basename("path", '.md') AS stripped FROM frontmatter WHERE "path" = ?`)).get('a.md')) as { full: unknown; stripped: unknown };
        assert.equal(row.full, 'a.md', store);
        assert.equal(row.stripped, 'a', store);
      })
    );
  });
});

// DuckDB composes lexical search from fts BM25 (ranking) plus contains() scans (exact substring, phrase verification, unspaced scripts), not FTS5. Shared fixtures assert the documented result properties.
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
  writeNote(baseDir, 'accented.md', { frontmatter: { title: 'Accented' }, body: 'The café is open.' });
  writeNote(baseDir, 'plain-accent.md', { frontmatter: { title: 'Plain' }, body: 'The cafe is open.' });
  writeNote(baseDir, 'accented-inflection.md', { frontmatter: { title: 'Accented inflection' }, body: 'The cafés are open.' });
  writeNote(baseDir, 'run.md', { body: 'run' });
  writeNote(baseDir, 'running.md', { body: 'running' });
  writeNote(baseDir, 'runs.md', { body: 'runs' });
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

function lexicalContractTree(): string {
  const baseDir = tmpTree();
  writeFileSync(join(baseDir, 'run.md'), '## Alpha\n\nrun fast\n');
  writeFileSync(join(baseDir, 'running.md'), '## Beta\n\nrunning fast\n');
  writeFileSync(join(baseDir, 'runs.md'), '## Gamma\n\nruns fast\n');
  writeFileSync(join(baseDir, 'title-body.md'), '---\ntitle: running\n---\n\nfast\n');
  writeFileSync(join(baseDir, 'title-summary.md'), '---\ntitle: running\nsummary: fast\n---\n\nneutral\n');
  writeFileSync(join(baseDir, 'summary-body.md'), '---\nsummary: running\n---\n\nfast\n');
  writeFileSync(join(baseDir, 'reordered.md'), '## Neutral reordered\n\nfast run\n');
  writeFileSync(join(baseDir, 'nonadjacent.md'), '## Neutral nonadjacent\n\nrun very fast\n');
  writeFileSync(join(baseDir, 'accented.md'), '## Neutral accented\n\nrésumés fast\n');
  writeFileSync(join(baseDir, 'plain-accented.md'), '## Neutral plain\n\nresumes fast\n');
  writeFileSync(join(baseDir, 'accented-base.md'), '## Neutral base\n\nresume fast\n');
  writeFileSync(join(baseDir, 'apostrophe-straight.md'), "## Neutral straight\n\nchildren's books\n");
  writeFileSync(join(baseDir, 'apostrophe-curly.md'), '## Neutral curly\n\nchildren’s books\n');
  writeFileSync(join(baseDir, 'apostrophe-spaced.md'), '## Neutral spaced\n\nchildren s books\n');
  writeFileSync(join(baseDir, 'hyphenated.md'), '## Neutral hyphenated\n\nchildren-books\n');
  writeFileSync(join(baseDir, 'nfd.md'), '## Neutral NFD\n\nre\u0301sume\u0301s fast\n');
  writeFileSync(join(baseDir, 'underscore.md'), '## Neutral underscore\n\nalpha_beta\n');
  writeFileSync(join(baseDir, 'underscore-spaced.md'), '## Neutral underscore spaced\n\nalpha beta\n');
  writeFileSync(join(baseDir, 'mixed-script.md'), '## Neutral mixed script\n\nrunning 北京\n');
  writeFileSync(join(baseDir, 'mixed-reordered.md'), '## Neutral mixed reordered\n\n北京 running\n');
  writeFileSync(join(baseDir, 'mixed-nonadjacent.md'), '## Neutral mixed nonadjacent\n\nrunning extra 北京\n');
  writeFileSync(join(baseDir, 'mixed-title-body.md'), '---\ntitle: running\n---\n\n北京\n');
  writeFileSync(join(baseDir, 'mixed-internal.md'), '## Neutral mixed internal\n\njog 北京 swiftly\n');
  writeFileSync(join(baseDir, 'mixed-internal-reordered.md'), '## Neutral mixed internal reordered\n\n北京 jog swiftly\n');
  writeFileSync(join(baseDir, 'double-stem.md'), '## Neutral double stem\n\ndeliberately fast\n');
  writeFileSync(join(baseDir, 'bare-and-phrase.md'), '## Neutral bare and phrase\n\ncat needle target\n');
  writeFileSync(join(baseDir, 'substring-and-phrase.md'), '## Neutral substring and phrase\n\nconcatenate needle target\n');
  return baseDir;
}

async function searchPaths(store: ParityStoreName, baseDir: string, terms: string): Promise<string[]> {
  return withTreeForStore(store, baseDir, async ({ store: s, cfg }) => {
    const rows = await search(s, cfg, terms);
    return rows.map((r) => r.path as string);
  });
}

// A store lacking a capability must fail loudly with STORE_CAPABILITY_MISSING naming it (PRINCIPLES: no-silent-modes); shared by every capability-gated case below.
// A missing-dependency error propagates before a store can be asked to reject a query.
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

    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        const hits = await store.lexical.query('sarsaparilla', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
        assert.deepEqual(
          hits.map((h) => h.path),
          ['title-hit.md', 'body-hit.md'],
          `${name}: field weighting must survive a bulk build; equal ordering means scoring collapsed`
        );
      })
    );
  });
});

// Every store's snippet is computed the same way (commands/search.ts), so this asserts the documented
// marker and content contract rather than relying on cross-store agreement.
describe('store parity: every store computes the same snippet (every store)', () => {
  const tree = () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'phrase.md'), 'planets\n');
    writeNote(baseDir, 'reordered.md', { frontmatter: { title: 'Reordered' }, body: 'planets and stars, in the other order entirely' });
    return baseDir;
  };

  it('every store returns the documented snippet for the fixture', async () => {
    const baseDir = tree();
    // DESIGN.md fixes the 80-character budget, word-edge cuts, and query markers, but not
    // trailing whitespace, so the oracle compares the documented content after trimEnd().
    const expectedSnippet = '«planets»';
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'planets');
        const row = rows.find((r) => r.path === 'phrase.md');
        assert.ok(row, `${name}: the fixture must match, or this asserts nothing`);
        assert.equal(row.path, 'phrase.md', `${name}: expected the documented fixture path`);
        const snippets = row.snippets as string[];
        assert.equal(snippets.length, 1, `${name}: expected one snippet`);
        assert.equal(snippets[0].trimEnd(), expectedSnippet, `${name}: snippet must mark the documented query in the fixture`);
        assert.ok(snippets[0].length <= 80, `${name}: snippet exceeds the documented character budget`);
        assert.doesNotMatch(snippets[0], /\n/, `${name}: snippet contains an undocumented newline`);
      })
    );
  });

  it('every store honors a caller character budget larger than the default', async () => {
    const baseDir = tmpTree();
    const body = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november planets india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray';
    const expectedSnippet = '…«planets» india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray';
    assert.ok(expectedSnippet.length > 80 && expectedSnippet.length <= 120, 'fixture must distinguish the caller budget from the default');
    writeFileSync(join(baseDir, 'long.md'), body);

    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'planets', { snippetCharLimit: 120 });
        assert.deepEqual(
          rows.map((candidate) => candidate.path),
          ['long.md'],
          `${name}: only the authored fixture should match`
        );
        const row = rows.find((candidate) => candidate.path === 'long.md');
        assert.ok(row, `${name}: the larger-budget fixture must match`);
        const snippets = row.snippets as string[];
        assert.equal(snippets.length, 1, `${name}: expected one snippet`);
        assert.equal(snippets[0], expectedSnippet, `${name}: the caller's larger budget must retain the complete authored passage`);
      })
    );
  });
});

// The exact fixture expectation above is independent of cross-store agreement (PLAN 3.62).
describe('store parity: snippet marking follows the query, not a substring scan (every store)', () => {
  it('a search for "the" marks only the word "the", never a fragment inside them/they/theme/theirs', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'note.md', { body: 'They said the theme was theirs, then they left them there.' });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'the');
        const row = rows.find((r) => r.path === 'note.md');
        assert.ok(row, `${name}: the fixture must match, or this asserts nothing`);
        const hit = (row.snippets as string[])[0];
        assert.match(hit, /«[Tt]he»/, `${name}: expected the real word "the" marked: ${hit}`);
        assert.doesNotMatch(hit, /«[Tt]he»[a-z]/i, `${name}: marked a fragment inside a longer word: ${hit}`);
        assert.doesNotMatch(hit, /[a-z]«[Tt]he»/i, `${name}: marked a fragment inside a longer word: ${hit}`);
      })
    );
  });

  // "running" also appears literally so every store's own lexical match qualifies the row;
  // the derived sidecar makes the stemmed variant "runs" searchable too.
  it('a search for "running" also marks "runs" via porter stemming', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'note.md', { body: 'He runs each morning and enjoys running.' });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'running');
        const row = rows.find((r) => r.path === 'note.md');
        assert.ok(row, `${name}: the fixture must match, or this asserts nothing`);
        const hit = (row.snippets as string[])[0];
        assert.match(hit, /«runs»/, `${name}: expected the stemmed variant "runs" marked: ${hit}`);
      })
    );
  });

  it('a search for an unaccented inflection marks the accented authored word', async () => {
    const baseDir = tmpTree();
    writeFileSync(join(baseDir, 'note.md'), 'résumés are ready.');
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'resume');
        const row = rows.find((r) => r.path === 'note.md');
        assert.ok(row, `${name}: the accented inflection must match`);
        assert.deepEqual(row.snippets, ['«résumés» are ready.'], `${name}: the authored accented word must be marked exactly`);
      })
    );
  });

  it('a CJK query marks its substring wherever it occurs, inside a longer unspaced run', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'note.md', { body: '図書館で全文検索のシステムを使って調べ物をした。' });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, '全文');
        const row = rows.find((r) => r.path === 'note.md');
        assert.ok(row, `${name}: the fixture must match, or this asserts nothing`);
        const hit = (row.snippets as string[])[0];
        assert.match(hit, /«全文»検索/, `${name}: expected 全文 marked inside 全文検索: ${hit}`);
      })
    );
  });

  it('a two-term query lands its window on the passage holding both terms', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'note.md', {
      body: 'The introduction covers unrelated weather and travel notes with no overlap at all here.\n\nLater in the document, planets and stars share the same paragraph, filling the night sky above the quiet town.',
    });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store, cfg }) => {
        const rows = await search(store, cfg, 'planets stars');
        const row = rows.find((r) => r.path === 'note.md');
        assert.ok(row, `${name}: the fixture must match, or this asserts nothing`);
        const hit = (row.snippets as string[])[0];
        assert.match(hit, /«planets»/, `${name}: expected planets marked: ${hit}`);
        assert.match(hit, /«stars»/, `${name}: expected stars marked: ${hit}`);
      })
    );
  });
});

// 'phrases' used to be a capability but is declared by every store, so quoted-phrase adjacency is
// asserted unconditionally here rather than dispatched.
describe('store parity: quoted phrases require adjacency (every store)', () => {
  it('a reordered doc is excluded', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'phrase.md', { frontmatter: { title: 'Astronomy' }, body: 'the stars and planets fill the night sky above us' });
    writeNote(baseDir, 'reordered.md', { frontmatter: { title: 'Reordered' }, body: 'planets and stars, in the other order entirely' });
    const opts = { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 };
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        const hits = await store.lexical.query('"stars and planets"', opts);
        assert.deepEqual(
          hits.map((h) => h.path),
          ['phrase.md'],
          `${name}: a quoted run must match adjacency and not a bag of words`
        );
      })
    );
  });
});

// segment() is the 'segment' capability's probe: has()/basename() now resolve on every store
// (above), but segment() calls Intl.Segmenter grapheme clustering with no SQL form, so it alone
// still separates a store that declares 'segment' from one that does not.
describe('store parity: segment is declared honestly (every store)', () => {
  it('a store declaring it resolves segment(), and one that does not rejects with STORE_CAPABILITY_MISSING', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const sql = `SELECT segment('东京') AS s FROM frontmatter WHERE "path" = 'a.md'`;

    await forEachStoreByCapability(
      'segment',
      async (name) => {
        await withTreeForStore(name, baseDir, async ({ store }) => {
          const rows: Array<{ s: string }> = [];
          for await (const row of (await store.raw.prepare(sql)).iterate() as AsyncIterable<{ s: string }>) rows.push(row);
          assert.equal(rows.length, 1, name);
          assert.equal(rows[0].s, '{title_seg summary_seg text_seg}:"东 京"', `${name}: documented segment() grapheme phrase rewrite`);
        });
      },
      async (name) => {
        await withTreeForStore(name, baseDir, async ({ store }) => {
          await assert.rejects(
            async () => {
              for await (const _ of (await store.raw.prepare(sql)).iterate());
            },
            (err: SenseError) => {
              assert.equal(err.code, 'STORE_CAPABILITY_MISSING', name);
              assert.match(err.message, /segment/, name);
              return true;
            }
          );
        });
      }
    );
  });
});

describe('store parity: the Store contract (every store)', () => {
  it("name matches the registry key, and capabilities match the store module's own declaration", async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        assert.equal(store.name, name);
        assert.deepEqual(new Set(store.capabilities), declaredCapabilities(name), name);
      })
    );
  });

  it('docs.columns() returns frontmatter column names, including dynamic keys', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        const columns = await store.docs.columns();
        for (const expected of ['path', 'title', 'tags']) assert.ok(columns.includes(expected), `${name}: expected '${expected}' among ${columns.join(', ')}`);
      })
    );
  });

  it('raw.prepare() streams rows through its async iterator', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        const stmt = await store.raw.prepare('SELECT "path" FROM frontmatter ORDER BY "path"');
        const rows: unknown[] = [];
        for await (const row of stmt.iterate()) rows.push(row);
        assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }], name);
      })
    );
  });

  // 2^53 + 9: past the safe-integer range, so a store that hands back a Number has already lost
  // digits by the time the assertion runs.
  it('raw.prepare() reads int64 values past 2^53 as BigInt', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    await forEachStore(async (name) =>
      withTreeForStore(name, baseDir, async ({ store }) => {
        const stmt = await store.raw.prepare('SELECT 9007199254740993 AS big');
        const rows: Array<{ big: unknown }> = [];
        for await (const row of stmt.iterate()) rows.push(row as { big: unknown });
        assert.equal(rows.length, 1, name);
        assert.equal(typeof rows[0].big, 'bigint', name);
        assert.equal(rows[0].big, BigInt('9007199254740993'), name);
      })
    );
  });
});

describe('store parity: lexical search (authored fixtures, D1)', () => {
  it('quoted inflected phrases use token stems and never cross fields', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) => {
      assert.deepEqual(await searchPaths(store, baseDir, '"run fast"'), ['run.md', 'running.md', 'runs.md'], `${store}: run phrase`);
      assert.deepEqual(await searchPaths(store, baseDir, '"running fast"'), ['run.md', 'running.md', 'runs.md'], `${store}: running phrase`);
      assert.deepEqual(await searchPaths(store, baseDir, '"run fast"'), ['run.md', 'running.md', 'runs.md'], `${store}: fields must stay separate`);
      assert.deepEqual(await searchPaths(store, baseDir, '"fast run"'), ['reordered.md'], `${store}: phrase order`);
      assert.deepEqual(await searchPaths(store, baseDir, '"run very fast"'), ['nonadjacent.md'], `${store}: phrase adjacency`);
    });
  });

  it('accented inflected phrases match the authored token set', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, '"resume fast"'), ['accented-base.md', 'accented.md', 'nfd.md', 'plain-accented.md'], store));
  });

  it('apostrophes and spaces are separators, while a hyphenated phrase keeps its token count', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) => {
      const apostrophePaths = await searchPaths(store, baseDir, `"children's books"`);
      assert.deepEqual(new Set(apostrophePaths), new Set(['apostrophe-curly.md', 'apostrophe-spaced.md', 'apostrophe-straight.md']), `${store}: apostrophe separators`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, '"children s books"')), new Set(apostrophePaths), `${store}: spaced separators`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, '"children’s books"')), new Set(apostrophePaths), `${store}: curly separators`);
      assert.deepEqual(await searchPaths(store, baseDir, '"children-books"'), ['hyphenated.md'], `${store}: hyphen separator`);
    });
  });

  it('the shared token contract handles NFD, underscores, and mixed Latin/CJK phrases', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) => {
      assert.deepEqual(new Set(await searchPaths(store, baseDir, 'resume')), new Set(['accented-base.md', 'accented.md', 'nfd.md', 'plain-accented.md']), `${store}: NFD document`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, 're\u0301sume')), new Set(['accented-base.md', 'accented.md', 'nfd.md', 'plain-accented.md']), `${store}: NFD query`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, 'alpha_beta')), new Set(['underscore-spaced.md', 'underscore.md']), `${store}: underscore query separators`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, '"alpha beta"')), new Set(['underscore-spaced.md', 'underscore.md']), `${store}: underscore document separators`);
      assert.deepEqual(new Set(await searchPaths(store, baseDir, 'run 北京')), new Set(['mixed-nonadjacent.md', 'mixed-reordered.md', 'mixed-script.md', 'mixed-title-body.md']), `${store}: mixed Latin/CJK terms`);
      const mixedPhrasePaths = await searchPaths(store, baseDir, '"run 北京"');
      assert.deepEqual(mixedPhrasePaths, ['mixed-script.md'], `${store}: mixed Latin/CJK phrase`);
      for (const negative of ['mixed-reordered.md', 'mixed-nonadjacent.md', 'mixed-title-body.md']) {
        assert.ok(!mixedPhrasePaths.includes(negative), `${store}: mixed phrase falsely matched ${negative}`);
      }
      await withTreeForStore(store, baseDir, async ({ store: s, cfg }) => {
        const nfd = (await search(s, cfg, 're\u0301sume')) as unknown as SearchResult[];
        const nfdMatch = nfd.find((row) => row.path === 'nfd.md');
        assert.deepEqual(
          nfdMatch?.snippets?.map((snippet) => snippet.trimEnd()),
          ['…«re\u0301sume\u0301s» fast'],
          `${store}: NFD snippet preserves authored marks`
        );
        assert.equal(nfdMatch?.lines, 'L1-4', `${store}: NFD section range`);
        const mixed = ((await search(s, cfg, '"run 北京"')) as unknown as SearchResult[])[0];
        assert.deepEqual(
          mixed?.snippets?.map((snippet) => snippet.trimEnd()),
          ['…«running» «北京»'],
          `${store}: mixed Latin/CJK snippet`
        );
        assert.equal(mixed?.lines, 'L1-4', `${store}: mixed Latin/CJK section range`);
      });
    });
  });

  it('keeps every token in mixed and stemmed phrases, and bare terms stay whole beside phrases', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) => {
      assert.deepEqual(await searchPaths(store, baseDir, '"jog 北京 swiftly"'), ['mixed-internal.md'], `${store}: internal CJK phrase token`);
      assert.deepEqual(await searchPaths(store, baseDir, '"deliberately fast"'), ['double-stem.md'], `${store}: phrase tokens are stemmed once`);
      assert.deepEqual(await searchPaths(store, baseDir, 'cat "needle target"'), ['bare-and-phrase.md'], `${store}: bare term beside a phrase`);
    });
  });

  it('combined lexical hits expose exact authored marks and containing section ranges', async () => {
    const baseDir = lexicalContractTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s, cfg }) => {
        const rows = (await search(s, cfg, '"run fast"')) as unknown as SearchResult[];
        assert.deepEqual(
          rows.map((row) => row.path),
          ['run.md', 'running.md', 'runs.md'],
          store
        );
        for (const row of rows) {
          const word = row.path === 'run.md' ? 'run' : row.path.slice(0, -3);
          assert.deepEqual(
            (row.snippets as string[]).map((snippet) => snippet.trimEnd()),
            [`…«${word}» «fast»`],
            `${store}: ${row.path} snippet`
          );
          assert.equal(row.lines, 'L1-4', `${store}: ${row.path} section range`);
        }
        const accentedRows = (await search(s, cfg, '"resume fast"')) as unknown as SearchResult[];
        assert.deepEqual(
          accentedRows.map((row) => [row.path, (row.snippets as string[])[0]?.trimEnd(), row.lines]),
          [
            ['accented-base.md', '…«resume» «fast»', 'L1-4'],
            ['accented.md', '…«résumés» «fast»', 'L1-4'],
            ['nfd.md', '…«re\u0301sume\u0301s» «fast»', 'L1-4'],
            ['plain-accented.md', '…«resumes» «fast»', 'L1-4'],
          ],
          `${store}: accented phrase snippets`
        );
        const apostropheRows = (await search(s, cfg, `"children's books"`)).sort((a, b) => (a.path as string).localeCompare(b.path as string));
        assert.deepEqual(
          apostropheRows.map((row) => [row.path, (row.snippets as string[])[0]?.trimEnd(), row.lines]),
          [
            ['apostrophe-curly.md', '…«children»’«s» «books»', 'L1-4'],
            ['apostrophe-spaced.md', '…«children» «s» «books»', 'L1-4'],
            ['apostrophe-straight.md', "…«children»'«s» «books»", 'L1-4'],
          ],
          `${store}: apostrophe phrase snippets`
        );
      })
    );
  });

  it('a plain term returns the authored match set and title hit', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => {
      const paths = await searchPaths(store, baseDir, 'apple');
      assert.deepEqual(paths[0], 'apple.md', store);
      assert.deepEqual(new Set(paths), new Set(['apple.md', 'both.md']), store);
    });
  });

  it('a bare multi-term query AND-joins identically: only the doc with every word matches', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'apple banana'), ['both.md'], store));
  });

  // A quoted phrase is token adjacency: punctuation between its words is a separator, so both
  // authored forms satisfy the same phrase contract in every native adapter.
  it('a quoted phrase crosses punctuation between adjacent words', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(new Set(await searchPaths(store, baseDir, '"customer-facing"')), new Set(['compound.md', 'not-compound.md']), store));
  });

  it('accented and unaccented spellings match the same authored words', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(new Set(await searchPaths(store, baseDir, 'cafe')), new Set(['accented.md', 'accented-inflection.md', 'plain-accent.md']), store));
  });

  it('the authored stemming oracle matches every inflection', async () => {
    const baseDir = lexicalFixtureTree();
    const expected = new Set(['run.md', 'running.md', 'runs.md']);
    await forEachStore(async (store) => assert.deepEqual(new Set(await searchPaths(store, baseDir, 'run')), expected, `${store}: authored stemming capability`));
  });

  it('Turso derives its stemmed accent-folded sidecar from authored text', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'derived.md', { body: 'Café running runs. Cafés.' });
    await withTreeForStore('turso', baseDir, async ({ store }) => {
      const row = (await (await store.prepare('SELECT text, text_stem FROM content WHERE path = ?')).get('derived.md')) as { text: string; text_stem: string };
      assert.equal(row.text, 'Café running runs. Cafés.');
      assert.equal(row.text_stem, 'cafe run run. cafe.');
    });
  });

  it('punctuation-only input is a valid empty result in every store', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, '!!!'), [], store));
  });

  it('a punctuation-only quoted phrase is empty, even when mixed with a word', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => {
      assert.deepEqual(await searchPaths(store, baseDir, '"!!!"'), [], `${store}: quoted punctuation`);
      assert.deepEqual(await searchPaths(store, baseDir, 'apple "!!!"'), [], `${store}: mixed quoted punctuation`);
    });
  });

  it('a quoted phrase requires adjacency: the reordered doc is excluded', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, '"stars and planets"'), ['phrase.md'], store));
  });

  it('a CJK substring query finds its authored note, without word spaces', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, '天气'), ['zh-weather.md'], store));
  });

  // A mixed-script query ANDs two engine mechanisms per store (sqlite: FTS5 terms + `_seg` grapheme phrases; duckdb: BM25 + contains(); turso: two FTS indexes).
  // Getting each half right but the conjunction wrong is silent (ranking goes flat, result set stays correct), so this asserts both halves narrow to the one matching note.
  it('a mixed ascii + CJK query ANDs both halves: only the authored note holding both matches', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'telescope 北京'), ['mixed.md'], store));
  });

  it('a bare word plus a quoted phrase ANDs both: the note holding only the phrase is excluded', async () => {
    const baseDir = lexicalFixtureTree();
    await forEachStore(async (store) => assert.deepEqual(await searchPaths(store, baseDir, 'telescope "night sky"'), ['mixed.md'], store));
  });

  // sqlite honors FTS5-only syntax (prefix `*`, boolean OR/NOT); every other store rejects it loudly with STORE_CAPABILITY_MISSING instead of a silent literal-term match (PRINCIPLES: no-silent-modes).
  // duckdb and turso both support lexical search but neither parses FTS5 syntax, so each names the operator it cannot answer.
  it('a prefix query: sqlite honors it, every other store rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'appl*');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'both.md']), 'sqlite');
    await forEachOtherStore((store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'appl*'), /prefix query/));
  });

  it('a boolean OR query: sqlite honors it, every other store rejects it loudly instead of answering differently', async () => {
    const baseDir = lexicalFixtureTree();
    const sqlitePaths = await searchPaths('sqlite', baseDir, 'apple OR banana');
    assert.deepEqual(new Set(sqlitePaths), new Set(['apple.md', 'banana.md', 'both.md']), 'sqlite');
    await forEachOtherStore((store) => assertCapabilityMissing(store, searchPaths(store, baseDir, 'apple OR banana'), /boolean operator/));
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

async function semanticEvidence(store: ParityStoreName, baseDir: string, embed: { model: string; provider: 'static' }, terms: string) {
  return withTreeForStore(
    store,
    baseDir,
    async ({ store: s, cfg }) => {
      const rows = (await search(s, cfg, terms)) as Array<{ path: string; via: string; similarity: number }>;
      const hasVector = Object.fromEntries(await Promise.all(['a.md', 'b.md'].map(async (path) => [path, await s.vectors.hasVector(path)] as const)));
      return { rows, hasVector };
    },
    { embed }
  );
}

describe('store parity: semantic search (authored model fixture, D2)', () => {
  it('a vector-only query keeps the authored match set, including a legitimate zero score', async () => {
    const baseDir = semanticFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    await forEachStoreByCapability(
      'vectors',
      async (store) => {
        const result = await semanticEvidence(store, baseDir, embed, 'pomme');
        assert.equal(result.rows[0]?.path, 'a.md', JSON.stringify(result.rows));
        assert.deepEqual(new Set(result.rows.map((r) => r.path)), new Set(['a.md', 'b.md']), store);
        assert.ok(
          result.rows.every((r) => r.via === 'vector' && Number.isFinite(r.similarity)),
          JSON.stringify(result.rows)
        );
        assert.equal(result.rows.find((r) => r.path === 'b.md')?.similarity, 0, JSON.stringify(result.rows));
        assert.deepEqual(result.hasVector, { 'a.md': true, 'b.md': true }, store);
      },
      (store) => assertCapabilityMissing(store, semanticEvidence(store, baseDir, embed, 'pomme'), /vectors/)
    );
  });
});

async function relatedEvidence(store: ParityStoreName, baseDir: string, embed: { model: string; provider: 'static' }, target: string) {
  return withTreeForStore(
    store,
    baseDir,
    async ({ store: s, cfg }) => {
      const rows = await relatedNotes(s, cfg, target, {}, 10);
      const hasVector = Object.fromEntries(await Promise.all(['similar.md', 'unrelated.md'].map(async (path) => [path, await s.vectors.hasVector(path)] as const)));
      return { rows, hasVector };
    },
    { embed }
  );
}

function assertRelatedEvidence(result: Awaited<ReturnType<typeof relatedEvidence>>, expected: string[], label: string): void {
  assert.deepEqual(
    result.rows.map((r) => r.path),
    expected,
    label
  );
  assert.equal(result.rows[1]?.similarity, 0, JSON.stringify(result.rows));
  assert.ok(
    result.rows.every((r) => Number.isFinite(r.similarity)),
    JSON.stringify(result.rows)
  );
  assert.deepEqual(result.hasVector, { 'similar.md': true, 'unrelated.md': true }, label);
}

describe('store parity: related (authored model fixture, D2)', () => {
  // Similarity ties remain unsettled; this fixture has distinct authored vectors (1 and 0), so no tie policy is asserted.
  it('returns the authored candidate order, excluding linked notes and retaining a zero score', async () => {
    const baseDir = relatedFixtureTree();
    const embed = { model: writeModel(), provider: 'static' as const };
    const expected = ['similar.md', 'unrelated.md'];
    await forEachStoreByCapability(
      'vectors',
      async (store) => {
        const result = await relatedEvidence(store, baseDir, embed, 'target.md');
        assertRelatedEvidence(result, expected, store);
      },
      (store) => assertCapabilityMissing(store, relatedEvidence(store, baseDir, embed, 'target.md'), /vectors/)
    );
  });
});

// map, scoped search, and findPath each materialize a path set into a temp table and filter against it.
// A whole-tree scope must change nothing; a narrowed scope must narrow identically on every store.
describe('store parity: scoped commands (authored fixtures)', () => {
  it('mapTree agrees with a whole-tree scope and with a narrowed include', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s, cfg }) => {
        const whole = await mapTree(s, cfg);
        assert.equal(whole.docs.count, 3, store);
        assert.equal(whole.hubs.length, 3, store);
        assert.equal(whole.recent.length, 3, store);
        assert.deepEqual(new Set(whole.hubs.map((h) => h.path)), new Set(['a.md', 'b.md', 'c.md']), `${store}: whole-tree hubs`);
        assert.deepEqual(new Set(whole.recent.map((r) => r.path)), new Set(['a.md', 'b.md', 'c.md']), `${store}: whole-tree recent`);
        // Field types are classified from decoded values, not engine typeof(), so the label is identical on every store.
        // priority is mixed (number in a.md, string in b.md, absent in c.md); tags is a JSON-stringified array; active is a boolean stored as an integer.
        const fieldTypes = Object.fromEntries(whole.fields.map((f) => [f.field, f.type]));
        assert.deepEqual(fieldTypes, { title: 'text', priority: 'integer,text', tags: 'text', active: 'integer' }, store);
        const narrowed = await mapTree(s, cfg, { include: ['a.md', 'b.md'] });
        assert.equal(narrowed.docs.count, 2, store);
        assert.equal(narrowed.hubs.length, 2, store);
        assert.equal(narrowed.recent.length, 2, store);
        assert.deepEqual(new Set(narrowed.hubs.map((h) => h.path)), new Set(['a.md', 'b.md']), `${store}: narrowed hubs`);
        assert.deepEqual(new Set(narrowed.recent.map((r) => r.path)), new Set(['a.md', 'b.md']), `${store}: narrowed recent`);
      })
    );
  });

  it('search agrees when the scope is narrowed with an include override', async () => {
    const baseDir = fixtureTree();
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s, cfg }) => {
        // a.md matches only via the link signal (b.md, a word hit, links back to it).
        const full = (await search(s, cfg, 'note')).map((r) => r.path as string);
        assert.deepEqual(new Set(full), new Set(['a.md', 'b.md', 'c.md']), store);
        const scoped = (await search(s, cfg, 'note', { include: ['c.md'] })).map((r) => r.path as string);
        assert.deepEqual(scoped, ['c.md'], store);
      })
    );
  });

  it('findPath agrees, with and without an allowed scope', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[[b]]' });
    writeNote(baseDir, 'b.md', { body: '[[c]]' });
    writeNote(baseDir, 'c.md', { body: 'end.' });
    await forEachStore(async (store) =>
      withTreeForStore(store, baseDir, async ({ store: s }) => {
        assert.deepEqual(await findPath(s, 'a.md', 'c.md'), ['a.md', 'b.md', 'c.md'], store);
        assert.deepEqual(await findPath(s, 'a.md', 'c.md', { allowed: new Set(['a.md', 'b.md', 'c.md']) }), ['a.md', 'b.md', 'c.md'], store);
        assert.equal(await findPath(s, 'a.md', 'c.md', { allowed: new Set(['a.md', 'c.md']) }), null, store);
      })
    );
  });
});
