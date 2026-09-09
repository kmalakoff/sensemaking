import assert from 'node:assert';
import { connect } from '@tursodatabase/database';
import type { SenseError } from '../../../../src/errors.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';
import { queryLexical } from '../../../../src/store/turso/lexical.ts';
import type { Connection } from '../../../../src/store/types.ts';

const SCHEMA = `CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT, title_stem TEXT, summary_stem TEXT, text_stem TEXT, title_ngram TEXT, summary_ngram TEXT, text_ngram TEXT)`;
const FTS = `CREATE INDEX content_fts ON content USING fts (title_stem, summary_stem, text_stem) WITH (weights = 'title_stem=10.0,summary_stem=5.0,text_stem=1.0')`;
const FTS_NGRAM = `CREATE INDEX content_fts_ngram ON content USING fts (title_ngram, summary_ngram, text_ngram) WITH (tokenizer='ngram', weights='title_ngram=10.0,summary_ngram=5.0,text_ngram=1.0')`;
const openDatabases = new Set<Awaited<ReturnType<typeof connect>>>();

async function makeConn(): Promise<Connection> {
  const db = await connect(':memory:', { experimental: ['index_method'] });
  openDatabases.add(db);
  try {
    await db.exec(SCHEMA);
    await db.exec(FTS);
    await db.exec(FTS_NGRAM);
    return createConnection(db);
  } catch (err) {
    try {
      await db.close();
    } finally {
      openDatabases.delete(db);
    }
    throw err;
  }
}

afterEach(async () => {
  const databases = [...openDatabases];
  try {
    await Promise.all(databases.map((db) => db.close()));
  } finally {
    for (const db of databases) openDatabases.delete(db);
  }
});

interface IndexedContent {
  title: string;
  summary: string;
  text: string;
  titleNgram?: string;
  summaryNgram?: string;
  textNgram?: string;
}

async function insertDoc(conn: Connection, path: string, title: string, summary: string, text: string, indexed: IndexedContent): Promise<void> {
  const stmt = await conn.prepare('INSERT INTO content VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  await stmt.run(path, title, summary, text, indexed.title, indexed.summary, indexed.text, indexed.titleNgram ?? '', indexed.summaryNgram ?? '', indexed.textNgram ?? '');
}

const BASE = { whereJoin: '', whereCond: '', scopeCond: '' };

describe('queryLexical (turso)', () => {
  it('the installed native tokenizer has no English stemmer', async () => {
    const db = await connect(':memory:', { experimental: ['index_method'] });
    try {
      await db.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO docs VALUES (1, 'run'), (2, 'running'), (3, 'runs');");
      await assert.rejects(db.exec("CREATE INDEX docs_fts_stem ON docs USING fts (body) WITH (tokenizer = 'en_stem')"), /unsupported FTS tokenizer 'en_stem'.*default, raw, simple, whitespace, ngram/);
      await db.exec('CREATE INDEX docs_fts_default ON docs USING fts (body)');
      for (const [query, id] of [
        ['run', 1],
        ['running', 2],
        ['runs', 3],
      ] as const) {
        const rows = await (await db.prepare(`SELECT id FROM docs WHERE fts_match(body, '${query}')`)).all();
        assert.deepEqual(rows, [{ id }], `default tokenizer must not stem ${query}`);
      }
    } finally {
      await db.close();
    }
  });

  it('a matching term returns the expected path', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'Astronomy', '', 'stars and planets', { title: 'astronomi', summary: '', text: 'star and planet' });
    await insertDoc(conn, 'b.md', 'Cooking', '', 'recipes and food', { title: 'cook', summary: '', text: 'recip and food' });
    const hits = await queryLexical(conn, 'astronomy', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
    assert.deepEqual(Object.keys(hits[0]), ['path'], 'a lexical hit is a match and nothing else; snippets are cut above the store');
  });

  it('accent folding uses the derived native-index fields', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'accented.md', '', '', 'café', { title: '', summary: '', text: 'cafe' });
    await insertDoc(conn, 'plain.md', '', '', 'cafe', { title: '', summary: '', text: 'cafe' });
    const hits = await queryLexical(conn, 'cafe', { ...BASE, limit: 10 });
    assert.deepEqual(new Set(hits.map((h) => h.path)), new Set(['accented.md', 'plain.md']));
  });

  it('a title hit outranks a body-only hit (field weighting)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'title-hit.md', 'widget', '', 'nothing else relevant here', { title: 'widget', summary: '', text: 'noth els relev here' });
    await insertDoc(conn, 'body-hit.md', 'unrelated', '', 'a widget is mentioned only in passing here', { title: 'unrel', summary: '', text: 'a widget is mention onli in pass here' });
    const hits = await queryLexical(conn, 'widget', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['title-hit.md', 'body-hit.md']
    );
  });

  it('a bare multi-word query AND-joins: one absent word means zero rows (Tantivy default is OR, not AND -- spike-corrected)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'both.md', '', '', 'apple and banana together', { title: '', summary: '', text: 'appl and banana togeth' });
    await insertDoc(conn, 'apple-only.md', '', '', 'just an apple here', { title: '', summary: '', text: 'just an appl here' });
    const hits = await queryLexical(conn, 'apple banana', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['both.md']
    );
  });

  it('a quoted phrase requires adjacency, via Tantivy phrase syntax', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'adjacent.md', '', '', 'stars and planets fill the sky', { title: '', summary: '', text: 'star and planet fill the sky' });
    await insertDoc(conn, 'apart.md', '', '', 'planets orbit distant stars', { title: '', summary: '', text: 'planet orbit distant star' });
    const hits = await queryLexical(conn, '"stars and planets"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['adjacent.md']
    );
  });

  it("a quoted punctuated term matches both sides of a hyphen split, agreeing with sqlite/FTS5 (not duckdb's contains() divergence)", async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'compound.md', '', '', 'a customer-facing dashboard', { title: '', summary: '', text: 'a custom-face dashboard' });
    await insertDoc(conn, 'not-compound.md', '', '', 'a customer facing away from the dashboard', { title: '', summary: '', text: 'a custom face awai from the dashboard' });
    const hits = await queryLexical(conn, '"customer-facing"', { ...BASE, limit: 10 });
    assert.deepEqual(new Set(hits.map((h) => h.path)), new Set(['compound.md', 'not-compound.md']));
  });

  it('an unspaced-script (CJK) run is found via the ngram sidecar index, unquoted', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'zh.md', '', '', '今天天气非常好,适合出去散步。', { title: '', summary: '', text: '今天天气非常好,适合出去散步。', textNgram: '今天天气非常好,适合出去散步。' });
    await insertDoc(conn, 'other.md', '', '', 'unrelated english text', { title: '', summary: '', text: 'unrel english text' });
    const hits = await queryLexical(conn, '天气', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['zh.md']
    );
  });

  it('the ngram sidecar index does not leak into bare-word matching (no substring bleed)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'plain english words apple banana', { title: '', summary: '', text: 'plain english word appl banana' });
    // "applx" is a bare near-prefix, not a wildcard query -- must miss, the same as sqlite/duckdb,
    // even though the ngram index exists in this database for the CJK path.
    const hits = await queryLexical(conn, 'applx', { ...BASE, limit: 10 });
    assert.deepEqual(hits, []);
  });

  // Both indexes in one query is the case fts_score's one-index-per-SELECT rule breaks silently:
  // as a single SELECT gated on both fts_match predicates, every score comes back 0 and ranking goes flat with no error, so this asserts the order rather than only the result set.
  it('a mixed ascii + unspaced-script query AND-joins across both indexes and still ranks', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'z-strong.md', 'widget 天气', '', 'widget', { title: 'widget 天气', summary: '', text: 'widget', titleNgram: 'widget 天气' });
    await insertDoc(conn, 'a-weak.md', '', '', 'a widget mentioned in passing, and 天气 too', { title: '', summary: '', text: 'a widget mention in pass, and 天气 too', textNgram: 'a widget mentioned in passing, and 天气 too' });
    await insertDoc(conn, 'ascii-only.md', 'widget', '', 'widget widget', { title: 'widget', summary: '', text: 'widget widget' });
    await insertDoc(conn, 'cjk-only.md', '天气', '', '今天天气非常好', { title: '天气', summary: '', text: '今天天气非常好', titleNgram: '天气', textNgram: '今天天气非常好' });
    const hits = await queryLexical(conn, 'widget 天气', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['z-strong.md', 'a-weak.md'],
      'only rows matching in both indexes, title hits first'
    );
  });

  it('narrows results by the caller-built scope condition', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'in-scope.md', 'apple', '', 'apple pie', { title: 'appl', summary: '', text: 'appl pie' });
    await insertDoc(conn, 'out-of-scope.md', 'apple', '', 'apple tart', { title: 'appl', summary: '', text: 'appl tart' });
    await conn.exec(`CREATE TEMP TABLE _search_scope ("path" TEXT)`);
    const stmt = await conn.prepare('INSERT INTO _search_scope VALUES (?)');
    await stmt.run('in-scope.md');
    const hits = await queryLexical(conn, 'apple', { whereJoin: '', whereCond: '', scopeCond: `AND content.path IN (SELECT "path" FROM _search_scope)`, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['in-scope.md']
    );
  });

  it('an empty terms string returns zero rows without issuing an fts query', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body', { title: 'first', summary: '', text: 'first bodi' });
    assert.deepEqual(await queryLexical(conn, '   ', { ...BASE, limit: 10 }), []);
  });

  // fts_score collapses to 0 for every row when the query is bound as `?` instead of interpolated
  // as a SQL literal (ranking flat, no error), and a term with a single quote is the case that would otherwise break interpolation: this proves the escaping is correct and the match/score still work through it.
  describe('FTS literal escaping (spike addendum)', () => {
    it('a query term containing a single quote matches correctly and does not break the SQL', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'a.md', "O'Brien's Diner", '', "a diner named O'Brien's", { title: 'o brien s diner', summary: '', text: 'a diner name o brien s' });
      await insertDoc(conn, 'b.md', 'unrelated', '', 'unrelated text', { title: 'unrel', summary: '', text: 'unrel text' });
      const hits = await queryLexical(conn, "O'Brien's", { ...BASE, limit: 10 });
      assert.deepEqual(
        hits.map((h) => h.path),
        ['a.md']
      );
    });

    it('a single-quote term still ranks a title hit above a body-only hit (fts_score is not flattened by the escaping)', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'title-hit.md', "O'Brien", '', 'nothing else relevant here', { title: "o'brien", summary: '', text: 'noth els relev here' });
      await insertDoc(conn, 'body-hit.md', 'unrelated', '', "an O'Brien is mentioned only in passing here", { title: 'unrel', summary: '', text: "an o'brien is mention onli in pass here" });
      const hits = await queryLexical(conn, "O'Brien", { ...BASE, limit: 10 });
      assert.deepEqual(
        hits.map((h) => h.path),
        ['title-hit.md', 'body-hit.md']
      );
    });

    it('a quoted phrase containing a single quote is escaped and matched correctly', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'a.md', '', '', "the cat's whiskers are long", { title: '', summary: '', text: 'the cat s whisker ar long' });
      await insertDoc(conn, 'b.md', '', '', 'whiskers are long on the cat', { title: '', summary: '', text: 'whisker ar long on the cat' });
      const hits = await queryLexical(conn, `"cat's whiskers"`, { ...BASE, limit: 10 });
      assert.deepEqual(
        hits.map((h) => h.path),
        ['a.md']
      );
    });
  });

  // A phantom {path: null} row can arise from a concurrent FTS read during an open write
  // transaction; reproduced here directly (a legitimate NULL primary key insert, not the race) to prove lexical.ts's own guard.
  it('raises a named error rather than returning a row with a null path', async () => {
    const conn = await makeConn();
    const stmt = await conn.prepare('INSERT INTO content VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    await stmt.run(null, 'phantom', '', 'phantom apple text', 'phantom', '', 'phantom appl text', '', '', '');
    await assert.rejects(
      () => queryLexical(conn, 'phantom', { ...BASE, limit: 10 }),
      (err: SenseError) => {
        assert.equal(err.code, 'LEXICAL_NULL_PATH');
        assert.match(err.message, /store "turso"/);
        return true;
      }
    );
  });
});

// FTS5 interprets these as operators; Tantivy's own grammar interprets several with different
// semantics (bare words disjunctive by default, `^` means boost not initial-token), so a bare query containing one is rejected loudly (PRINCIPLES: no-silent-modes) instead of silently answering differently from sqlite.
describe('queryLexical (turso): rejected FTS5 operators', () => {
  const cases: Array<{ name: string; terms: string; token: string }> = [
    { name: 'prefix query ("foo*")', terms: 'foo*', token: 'foo*' },
    { name: 'boolean OR', terms: 'foo OR bar', token: 'OR' },
    { name: 'boolean NOT', terms: 'foo NOT bar', token: 'NOT' },
    { name: 'boolean AND', terms: 'foo AND bar', token: 'AND' },
    { name: 'NEAR operator', terms: 'foo NEAR bar', token: 'NEAR' },
    { name: 'initial-token operator ("^foo")', terms: '^foo bar', token: '^foo' },
    { name: 'Tantivy boost operator ("foo^5")', terms: 'foo^5 bar', token: 'foo^5' },
    { name: 'column filter ("title:foo")', terms: 'title:foo', token: 'title:' },
  ];

  for (const { name, terms, token } of cases) {
    it(`rejects ${name} with STORE_CAPABILITY_MISSING naming the operator`, async () => {
      const conn = await makeConn();
      await assert.rejects(
        () => queryLexical(conn, terms, { ...BASE, limit: 10 }),
        (err: SenseError) => {
          assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
          assert.match(err.message, /store "turso" does not implement/);
          assert.ok(err.message.includes(token), `expected message to name "${token}": ${err.message}`);
          return true;
        }
      );
    });
  }

  it('does not reject a lowercase "or"/"and"/"not" bareword (not an operator unless uppercase)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo or bar and not baz', { title: '', summary: '', text: 'foo or bar and not baz' });
    const hits = await queryLexical(conn, 'foo or bar', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });

  it('does not reject a quoted phrase, even one that contains operator-shaped text', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo AND bar together', { title: '', summary: '', text: 'foo and bar togeth' });
    const hits = await queryLexical(conn, '"foo AND bar"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });
});
