import assert from 'node:assert';
import { connect } from '@tursodatabase/database';
import type { SenseError } from '../../../../src/errors.ts';
import { createConnection } from '../../../../src/store/turso/connection.ts';
import { queryLexical } from '../../../../src/store/turso/lexical.ts';
import type { Connection } from '../../../../src/store/types.ts';

const SCHEMA = `CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT, title_ngram TEXT, summary_ngram TEXT, text_ngram TEXT)`;
const FTS = `CREATE INDEX content_fts ON content USING fts (title, summary, text) WITH (weights = 'title=10.0,summary=5.0,text=1.0')`;
const FTS_NGRAM = `CREATE INDEX content_fts_ngram ON content USING fts (title_ngram, summary_ngram, text_ngram) WITH (tokenizer='ngram', weights='title_ngram=10.0,summary_ngram=5.0,text_ngram=1.0')`;

async function makeConn(): Promise<Connection> {
  const db = await connect(':memory:', { experimental: ['index_method'] });
  await db.exec(SCHEMA);
  await db.exec(FTS);
  await db.exec(FTS_NGRAM);
  return createConnection(db);
}

// Mirrors reconcile.ts's contentRow: ngram sidecars carry the field's own text only when it has
// an unspaced-script run, '' otherwise (the same predicate reconcile.ts uses).
const UNSPACED_RUN = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Khmer}\p{scx=Lao}\p{scx=Myanmar}]/u;
function ngram(text: string): string {
  return UNSPACED_RUN.test(text) ? text : '';
}

async function insertDoc(conn: Connection, path: string, title: string, summary: string, text: string): Promise<void> {
  const stmt = await conn.prepare('INSERT INTO content VALUES (?, ?, ?, ?, ?, ?, ?)');
  await stmt.run(path, title, summary, text, ngram(title), ngram(summary), ngram(text));
}

const BASE = { whereJoin: '', whereCond: '', scopeCond: '' };

describe('queryLexical (turso)', () => {
  it('a matching term returns the expected path', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'Astronomy', '', 'stars and planets');
    await insertDoc(conn, 'b.md', 'Cooking', '', 'recipes and food');
    const hits = await queryLexical(conn, 'astronomy', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
    assert.equal(hits[0].hit, null, 'no bounded snippet equivalent -- hit is always null');
  });

  it('a title hit outranks a body-only hit (field weighting)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'title-hit.md', 'widget', '', 'nothing else relevant here');
    await insertDoc(conn, 'body-hit.md', 'unrelated', '', 'a widget is mentioned only in passing here');
    const hits = await queryLexical(conn, 'widget', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['title-hit.md', 'body-hit.md']
    );
  });

  it('a bare multi-word query AND-joins: one absent word means zero rows (Tantivy default is OR, not AND -- spike-corrected)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'both.md', '', '', 'apple and banana together');
    await insertDoc(conn, 'apple-only.md', '', '', 'just an apple here');
    const hits = await queryLexical(conn, 'apple banana', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['both.md']
    );
  });

  it('a quoted phrase requires adjacency, via Tantivy phrase syntax', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'adjacent.md', '', '', 'stars and planets fill the sky');
    await insertDoc(conn, 'apart.md', '', '', 'planets orbit distant stars');
    const hits = await queryLexical(conn, '"stars and planets"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['adjacent.md']
    );
  });

  it("a quoted punctuated term matches both sides of a hyphen split, agreeing with sqlite/FTS5 (not duckdb's contains() divergence)", async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'compound.md', '', '', 'a customer-facing dashboard');
    await insertDoc(conn, 'not-compound.md', '', '', 'a customer facing away from the dashboard');
    const hits = await queryLexical(conn, '"customer-facing"', { ...BASE, limit: 10 });
    assert.deepEqual(new Set(hits.map((h) => h.path)), new Set(['compound.md', 'not-compound.md']));
  });

  it('an unspaced-script (CJK) run is found via the ngram sidecar index, unquoted', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'zh.md', '', '', '今天天气非常好,适合出去散步。');
    await insertDoc(conn, 'other.md', '', '', 'unrelated english text');
    const hits = await queryLexical(conn, '天气', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['zh.md']
    );
  });

  it('the ngram sidecar index does not leak into bare-word matching (no substring bleed)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'plain english words apple banana');
    // "appl" is a bare substring, not a wildcard query -- must miss, the same as sqlite/duckdb,
    // even though the ngram index exists in this database for the CJK path.
    const hits = await queryLexical(conn, 'appl', { ...BASE, limit: 10 });
    assert.deepEqual(hits, []);
  });

  // Both indexes in one query is the case fts_score's one-index-per-SELECT rule breaks silently:
  // as a single SELECT gated on both fts_match predicates, every score comes back 0 and ranking goes flat with no error, so this asserts the order rather than only the result set.
  it('a mixed ascii + unspaced-script query AND-joins across both indexes and still ranks', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'z-strong.md', 'widget 天气', '', 'widget');
    await insertDoc(conn, 'a-weak.md', '', '', 'a widget mentioned in passing, and 天气 too');
    await insertDoc(conn, 'ascii-only.md', 'widget', '', 'widget widget');
    await insertDoc(conn, 'cjk-only.md', '天气', '', '今天天气非常好');
    const hits = await queryLexical(conn, 'widget 天气', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['z-strong.md', 'a-weak.md'],
      'only rows matching in both indexes, title hits first'
    );
  });

  it('narrows results by the caller-built scope condition', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'in-scope.md', 'apple', '', 'apple pie');
    await insertDoc(conn, 'out-of-scope.md', 'apple', '', 'apple tart');
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
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    assert.deepEqual(await queryLexical(conn, '   ', { ...BASE, limit: 10 }), []);
  });

  // fts_score collapses to 0 for every row when the query is bound as `?` instead of interpolated
  // as a SQL literal (ranking flat, no error), and a term with a single quote is the case that would otherwise break interpolation: this proves the escaping is correct and the match/score still work through it.
  describe('FTS literal escaping (spike addendum)', () => {
    it('a query term containing a single quote matches correctly and does not break the SQL', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'a.md', "O'Brien's Diner", '', "a diner named O'Brien's");
      await insertDoc(conn, 'b.md', 'unrelated', '', 'unrelated text');
      const hits = await queryLexical(conn, "O'Brien's", { ...BASE, limit: 10 });
      assert.deepEqual(
        hits.map((h) => h.path),
        ['a.md']
      );
    });

    it('a single-quote term still ranks a title hit above a body-only hit (fts_score is not flattened by the escaping)', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'title-hit.md', "O'Brien", '', 'nothing else relevant here');
      await insertDoc(conn, 'body-hit.md', 'unrelated', '', "an O'Brien is mentioned only in passing here");
      const hits = await queryLexical(conn, "O'Brien", { ...BASE, limit: 10 });
      assert.deepEqual(
        hits.map((h) => h.path),
        ['title-hit.md', 'body-hit.md']
      );
    });

    it('a quoted phrase containing a single quote is escaped and matched correctly', async () => {
      const conn = await makeConn();
      await insertDoc(conn, 'a.md', '', '', "the cat's whiskers are long");
      await insertDoc(conn, 'b.md', '', '', 'whiskers are long on the cat');
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
    const stmt = await conn.prepare('INSERT INTO content VALUES (?, ?, ?, ?, ?, ?, ?)');
    await stmt.run(null, 'phantom', '', 'phantom apple text', '', '', '');
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
    await insertDoc(conn, 'a.md', '', '', 'foo or bar and not baz');
    const hits = await queryLexical(conn, 'foo or bar', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });

  it('does not reject a quoted phrase, even one that contains operator-shaped text', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo AND bar together');
    const hits = await queryLexical(conn, '"foo AND bar"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });
});
