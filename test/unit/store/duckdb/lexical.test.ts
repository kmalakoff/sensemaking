import assert from 'node:assert';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { SenseError } from '../../../../src/errors.ts';
import { createConnection } from '../../../../src/store/duckdb/connection.ts';
import { createLexicalIndex, markContentStale } from '../../../../src/store/duckdb/lexical.ts';
import { ORDERED_BM25_MACRO, validateNativeMacroContract } from '../../../../src/store/duckdb/ordered-bm25.ts';
import { getMeta } from '../../../../src/store/shared.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { tmpTree } from '../../../lib/tree.ts';

async function makeConn(): Promise<Connection> {
  const instance = await DuckDBInstance.create(':memory:');
  const duckdb = await instance.connect();
  const conn = createConnection(duckdb);
  await conn.exec(`CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  return conn;
}

// File-backed (not :memory:), so a second connection can reopen the same on-disk state after the
// first closes -- what a fresh CLI process actually does, per PLAN 3.60.
async function openFileConn(dbPath: string): Promise<{ conn: Connection; close: () => void }> {
  const instance = await DuckDBInstance.create(dbPath);
  const duckdb = await instance.connect();
  const conn = createConnection(duckdb);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  return {
    conn,
    close: () => {
      duckdb.disconnectSync();
      instance.closeSync();
    },
  };
}

// Spies on the real exec() to count PRAGMA create_fts_index calls -- a discrete fact, not a
// timing measurement, so it proves a rebuild did or didn't run rather than merely how long it took.
function countFtsRebuilds(conn: Connection): () => number {
  const real = conn.exec.bind(conn);
  let count = 0;
  conn.exec = async (sql: string) => {
    if (sql.includes('create_fts_index')) count++;
    return real(sql);
  };
  return () => count;
}

async function insertDoc(conn: Connection, path: string, title: string, summary: string, text: string): Promise<void> {
  const stmt = await conn.prepare('INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)');
  await stmt.run(path, title, summary, text);
}

const BASE = { whereJoin: '', whereCond: '', scopeCond: '' };

describe('queryLexical (duckdb)', () => {
  it('uses the generated native BM25 formula with deterministic subscore accumulation', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'alpha beta gamma');
    await insertDoc(conn, 'b.md', '', '', 'alpha beta gamma');
    await insertDoc(conn, 'frequency.md', '', '', 'alpha alpha alpha');
    const { query } = createLexicalIndex(conn);
    const expected = ['a.md', 'b.md'];
    for (let i = 0; i < 12; i++)
      assert.deepEqual(
        (await query('alpha beta gamma', { ...BASE, limit: 10 })).map((hit) => hit.path),
        expected
      );
    const macro = (await (await conn.prepare(`SELECT macro_definition FROM duckdb_functions() WHERE function_name = '${ORDERED_BM25_MACRO}'`)).get()) as { macro_definition: string };
    assert.match(macro.macro_definition, /sum\(subscore ORDER BY subscore\)/);
    assert.doesNotMatch(macro.macro_definition, /sum\(subscore\)(?! ORDER BY)/);

    const combined = ((await (await conn.prepare(`SELECT ${ORDERED_BM25_MACRO}('a.md', ?, fields := 'text', conjunctive := false) AS score`)).get('alpha beta gamma')) as { score: number }).score;
    const nativeIndividual = [];
    const orderedIndividual = [];
    for (const term of ['alpha', 'beta', 'gamma']) {
      const scores = (await (await conn.prepare(`SELECT fts_main_content.match_bm25('a.md', ?, fields := 'text', conjunctive := false) AS native_score, ${ORDERED_BM25_MACRO}('a.md', ?, fields := 'text', conjunctive := false) AS ordered_score`)).get(term, term)) as { native_score: number; ordered_score: number };
      assert.strictEqual(scores.ordered_score, scores.native_score);
      nativeIndividual.push(scores.native_score);
      orderedIndividual.push(scores.ordered_score);
    }
    assert.deepEqual(orderedIndividual, nativeIndividual);
    assert.strictEqual(
      combined,
      nativeIndividual.sort((a, b) => a - b).reduce((sum, score) => sum + score, 0)
    );
  });

  it('rejects a changed native version or macro contract', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'alpha beta');
    await createLexicalIndex(conn).query('alpha', { ...BASE, limit: 10 });
    const native = (await (
      await conn.prepare(`
      SELECT version() AS version, function_type, parameters, parameter_types, macro_definition
      FROM duckdb_functions() WHERE schema_name = 'fts_main_content' AND function_name = 'match_bm25'
    `)
    ).get()) as { version: string; function_type: string; parameters: unknown; parameter_types: unknown; macro_definition: string };
    assert.doesNotThrow(() => validateNativeMacroContract({ version: native.version, macro: native }));
    assert.throws(
      () => validateNativeMacroContract({ version: 'v1.5.6', macro: native }),
      (error: unknown) => {
        assert.equal((error as SenseError).code, 'STORE_CAPABILITY_MISSING');
        assert.match((error as Error).message, /DuckDB v1\.5\.6 is unsupported/);
        return true;
      }
    );
    assert.throws(
      () => validateNativeMacroContract({ version: native.version, macro: { ...native, macro_definition: native.macro_definition.replace('sum(subscore)', 'sum(other)') } }),
      (error: unknown) => {
        assert.equal((error as SenseError).code, 'STORE_CAPABILITY_MISSING');
        assert.match((error as Error).message, /definition or reviewed parameter-default contract changed/);
        return true;
      }
    );
  });

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
    assert.deepEqual(Object.keys(hits[0]), ['path'], 'a lexical hit is a match and nothing else; snippets are cut above the store');
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

  it('verifies a large authored field in one bounded post-filter pass', async () => {
    const conn = await makeConn();
    const large = `${'padding '.repeat(120_000)}needle target`;
    await insertDoc(conn, 'large.md', '', '', large);
    const { query } = createLexicalIndex(conn);
    const hits = await query('"needle target"', { ...BASE, limit: 1 });
    assert.deepEqual(
      hits.map((hit) => hit.path),
      ['large.md']
    );
  });

  it('a quoted punctuated phrase matches adjacent words across punctuation', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', '', '', 'a customer-facing dashboard');
    await insertDoc(conn, 'spaced.md', '', '', 'a customer facing away from the dashboard');
    const { query } = createLexicalIndex(conn);
    const hits = await query('"Customer-Facing"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['hit.md', 'spaced.md']
    );
  });

  it('a quoted punctuation-only phrase is empty, even when mixed with a word', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', '', '', 'apple dashboard');
    const { query } = createLexicalIndex(conn);
    assert.deepEqual(await query('"!!!"', { ...BASE, limit: 10 }), []);
    assert.deepEqual(await query('apple "!!!"', { ...BASE, limit: 10 }), []);
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
    await markStale();
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

// PLAN 3.60: a fresh connection must trust meta.fts_stale over assuming stale, or every CLI
// invocation pays a full rebuild regardless of whether content changed since the last one.
describe('queryLexical (duckdb): fts staleness persists across connections (PLAN 3.60)', () => {
  it('a second connection over an unchanged cache does not rebuild', async () => {
    const dbPath = join(tmpTree(), 'cache.duckdb');
    const first = await openFileConn(dbPath);
    await insertDoc(first.conn, 'a.md', 'first', '', 'first body');
    await createLexicalIndex(first.conn).query('first', { ...BASE, limit: 10 });
    assert.equal(await getMeta(first.conn, 'fts_stale'), '0');
    first.close();

    const second = await openFileConn(dbPath);
    assert.equal(await getMeta(second.conn, 'fts_stale'), '0', "the clear must have persisted to disk, not just this connection's memory");
    const rebuilds = countFtsRebuilds(second.conn);
    const secondIndex = createLexicalIndex(second.conn);
    const hits = await secondIndex.query('first', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
    assert.equal(rebuilds(), 0, 'unchanged content must not pay another create_fts_index rebuild');
    assert.deepEqual(
      (await secondIndex.query('first', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['a.md']
    );
    const macro = (await (await second.conn.prepare(`SELECT macro_definition FROM duckdb_functions() WHERE function_name = '${ORDERED_BM25_MACRO}'`)).get()) as { macro_definition: string };
    assert.match(macro.macro_definition, /sum\(subscore ORDER BY subscore\)/);
    second.close();
  });

  it('content changed between connections does rebuild', async () => {
    const dbPath = join(tmpTree(), 'cache.duckdb');
    const first = await openFileConn(dbPath);
    await insertDoc(first.conn, 'a.md', 'first', '', 'first body');
    await createLexicalIndex(first.conn).query('first', { ...BASE, limit: 10 });
    first.close();

    const second = await openFileConn(dbPath);
    await insertDoc(second.conn, 'b.md', 'second', '', 'second body');
    // Mirrors what reconcileContent (reconcile.ts) does inside its own transaction when content changes.
    await markContentStale(second.conn);
    const rebuilds = countFtsRebuilds(second.conn);
    const hits = await createLexicalIndex(second.conn).query('second', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['b.md']
    );
    assert.equal(rebuilds(), 1, 'changed content must rebuild exactly once');
    assert.equal(await getMeta(second.conn, 'fts_stale'), '0');
    second.close();
  });

  it('recreates the connection-local adapter at the rebuild boundary', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const index = createLexicalIndex(conn);
    await index.query('first', { ...BASE, limit: 10 });
    await conn.exec(`CREATE OR REPLACE TEMP MACRO ${ORDERED_BM25_MACRO}(docname, query_string, fields := NULL, k := 1.2, b := 0.75, conjunctive := false) AS NULL`);
    await insertDoc(conn, 'b.md', 'second', '', 'second body');
    await markContentStale(conn);
    assert.deepEqual(
      (await index.query('second', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['b.md']
    );
    const macro = (await (await conn.prepare(`SELECT macro_definition FROM duckdb_functions() WHERE function_name = '${ORDERED_BM25_MACRO}'`)).get()) as { macro_definition: string };
    assert.match(macro.macro_definition, /sum\(subscore ORDER BY subscore\)/);
  });
});
