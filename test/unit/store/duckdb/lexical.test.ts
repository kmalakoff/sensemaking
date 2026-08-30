import assert from 'node:assert';
import { DuckDBInstance } from '@duckdb/node-api';
import type { SenseError } from '../../../../src/errors.ts';
import { createConnection } from '../../../../src/store/duckdb/connection.ts';
import { createLexicalIndex } from '../../../../src/store/duckdb/lexical.ts';
import type { Connection } from '../../../../src/store/types.ts';

async function makeConn(): Promise<Connection> {
  const instance = await DuckDBInstance.create(':memory:');
  const duckdb = await instance.connect();
  const conn = createConnection(duckdb);
  await conn.exec(`CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  return conn;
}

async function insertDoc(conn: Connection, path: string, title: string, summary: string, text: string): Promise<void> {
  const stmt = await conn.prepare('INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)');
  await stmt.run(path, title, summary, text);
}

const BASE = { whereJoin: '', whereCond: '', scopeCond: '' };

describe('queryLexical (duckdb)', () => {
  it('a matching term returns the expected path (bm25 branch)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'Astronomy', '', 'stars and planets');
    await insertDoc(conn, 'b.md', 'Cooking', '', 'recipes and food');
    const { query } = createLexicalIndex(conn);
    const hits = await query('astronomy', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
    assert.equal(hits[0].hit, null, 'no snippet() equivalent -- hit is always null');
  });

  it('a title hit outranks a body-only hit (field weighting)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'title-hit.md', 'widget', '', 'nothing else relevant here');
    await insertDoc(conn, 'body-hit.md', 'unrelated', '', 'a widget is mentioned only in passing here');
    const { query } = createLexicalIndex(conn);
    const hits = await query('widget', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['title-hit.md', 'body-hit.md']
    );
  });

  it('a bare multi-word query AND-joins: one absent word means zero rows', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'both.md', '', '', 'apple and banana together');
    await insertDoc(conn, 'apple-only.md', '', '', 'just an apple here');
    const { query } = createLexicalIndex(conn);
    const hits = await query('apple banana', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['both.md']
    );
  });

  it('a quoted phrase requires the literal substring, not just both words present', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'adjacent.md', '', '', 'stars and planets fill the sky');
    await insertDoc(conn, 'apart.md', '', '', 'planets orbit distant stars');
    const { query } = createLexicalIndex(conn);
    const hits = await query('"stars and planets"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['adjacent.md']
    );
  });

  it('a quoted punctuated term matches as an exact substring, unsplit by punctuation', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', '', '', 'a customer-facing dashboard');
    await insertDoc(conn, 'miss.md', '', '', 'a customer facing away from the dashboard');
    const { query } = createLexicalIndex(conn);
    const hits = await query('"customer-facing"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['hit.md']
    );
  });

  it('an unspaced-script (CJK) run is found via contains(), unquoted', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'zh.md', '', '', '今天天气非常好,适合出去散步。');
    await insertDoc(conn, 'other.md', '', '', 'unrelated english text');
    const { query } = createLexicalIndex(conn);
    const hits = await query('天气', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['zh.md']
    );
  });

  it('narrows results by the caller-built scope condition', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'in-scope.md', 'apple', '', 'apple pie');
    await insertDoc(conn, 'out-of-scope.md', 'apple', '', 'apple tart');
    await conn.exec(`CREATE TEMP TABLE _search_scope ("path" TEXT)`);
    const stmt = await conn.prepare('INSERT INTO _search_scope VALUES (?)');
    await stmt.run('in-scope.md');
    const { query } = createLexicalIndex(conn);
    const hits = await query('apple', { whereJoin: '', whereCond: '', scopeCond: `AND content.path IN (SELECT "path" FROM _search_scope)`, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['in-scope.md']
    );
  });

  it('rebuilds the fts index after markStale(), picking up content written since the last query', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const { query, markStale } = createLexicalIndex(conn);
    assert.deepEqual(
      (await query('second', { ...BASE, limit: 10 })).map((h) => h.path),
      []
    );
    await insertDoc(conn, 'b.md', 'second', '', 'second body');
    markStale();
    assert.deepEqual(
      (await query('second', { ...BASE, limit: 10 })).map((h) => h.path),
      ['b.md']
    );
  });

  it('an empty terms string returns zero rows without touching the fts extension', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const { query } = createLexicalIndex(conn);
    assert.deepEqual(await query('   ', { ...BASE, limit: 10 }), []);
  });
});

// FTS5 treats these as operators; duckdb's word/substring split does not, so a bare query
// containing one is rejected loudly (PRINCIPLES: no-silent-modes) rather than matched literally.
describe('queryLexical (duckdb): rejected FTS5 operators', () => {
  const cases: Array<{ name: string; terms: string; token: string }> = [
    { name: 'prefix query ("foo*")', terms: 'foo*', token: 'foo*' },
    { name: 'boolean OR', terms: 'foo OR bar', token: 'OR' },
    { name: 'boolean NOT', terms: 'foo NOT bar', token: 'NOT' },
    { name: 'boolean AND', terms: 'foo AND bar', token: 'AND' },
    { name: 'NEAR operator', terms: 'NEAR(foo bar, 5)', token: 'NEAR' },
    { name: 'initial-token operator ("^foo")', terms: '^foo bar', token: '^foo' },
    { name: 'column filter ("title:foo")', terms: 'title:foo', token: 'title:' },
  ];

  for (const { name, terms, token } of cases) {
    it(`rejects ${name} with STORE_CAPABILITY_MISSING naming the operator`, async () => {
      const conn = await makeConn();
      const { query } = createLexicalIndex(conn);
      await assert.rejects(
        () => query(terms, { ...BASE, limit: 10 }),
        (err: SenseError) => {
          assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
          assert.match(err.message, /store "duckdb" does not implement/);
          assert.ok(err.message.includes(token), `expected message to name "${token}": ${err.message}`);
          return true;
        }
      );
    });
  }

  it('does not reject a lowercase "or"/"and"/"not" bareword (not an FTS5 operator unless uppercase)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo or bar and not baz');
    const { query } = createLexicalIndex(conn);
    const hits = await query('foo or bar', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });

  it('does not reject a quoted phrase, even one that contains operator-shaped text', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo AND bar together');
    const { query } = createLexicalIndex(conn);
    const hits = await query('"foo AND bar"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });
});
