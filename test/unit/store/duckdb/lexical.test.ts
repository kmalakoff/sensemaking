import assert from 'node:assert';
import { rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { SenseError } from '../../../../src/errors.ts';
import { listFiles, parseFile } from '../../../../src/scan/index.ts';
import { createConnection } from '../../../../src/store/duckdb/connection.ts';
import { assertFtsReady, createLexicalIndex, markContentStale, prepareFts } from '../../../../src/store/duckdb/lexical.ts';
import { nativeQueryTerms, orderedBm25Sql } from '../../../../src/store/duckdb/ordered-bm25.ts';
import { duckdbDialect } from '../../../../src/store/duckdb/reconcile.ts';
import { getMeta } from '../../../../src/store/shared.ts';
import { withTransaction } from '../../../../src/store/transaction.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { tmpTree, writeNote } from '../../../lib/tree.ts';

const nativeClosers: Array<() => void> = [];
afterEach(() => {
  const errors: unknown[] = [];
  for (const close of nativeClosers.splice(0)) {
    try {
      close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'DuckDB test cleanup failed');
});

function closeNative(instance: DuckDBInstance, duckdb?: DuckDBConnection): void {
  const errors: unknown[] = [];
  try {
    duckdb?.disconnectSync();
  } catch (error) {
    errors.push(error);
  }
  try {
    instance.closeSync();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, 'DuckDB test resource cleanup failed');
}

async function makeConn(): Promise<Connection> {
  return (await openFileConn(':memory:')).conn;
}

// File-backed connections let another connection reopen the durable index and readiness marker.
async function openFileConn(dbPath: string): Promise<{ conn: Connection; close: () => void }> {
  const instance = await DuckDBInstance.create(dbPath);
  let duckdb: DuckDBConnection | undefined;
  try {
    duckdb = await instance.connect();
    const conn = createConnection(duckdb);
    await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
    await conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closeNative(instance, duckdb);
    };
    nativeClosers.push(close);
    return { conn, close };
  } catch (error) {
    try {
      closeNative(instance, duckdb);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'DuckDB test connection initialization and cleanup failed');
    }
    throw error;
  }
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

async function preparedIndex(conn: Connection): Promise<ReturnType<typeof createLexicalIndex>> {
  await prepareFts(conn);
  return createLexicalIndex(conn);
}

describe('queryLexical (duckdb)', () => {
  it('orders unequal native contributions exactly across repeated, reordered and parallel queries', async () => {
    const conn = await makeConn();
    await conn.exec('SET threads = 4');
    for (const path of ['b.md', 'a.md']) await insertDoc(conn, path, 'alpha beta', 'beta gamma', `alpha alpha alpha beta gamma ${'padding '.repeat(19)}`);
    for (let i = 0; i < 300; i++) await insertDoc(conn, `filler-${i}.md`, '', '', `${i % 5 < 2 ? 'alpha alpha beta' : i % 5 < 4 ? 'alpha' : 'gamma'} ${'padding '.repeat(i % 11)}`);
    const { query } = await preparedIndex(conn);
    await query('alpha', { ...BASE, limit: 10 });
    const expectedByField: number[] = [];
    for (const field of ['title', 'summary', 'text']) {
      const contributions: number[] = [];
      for (const term of ['alpha', 'beta', 'gamma']) {
        const score = (await (await conn.prepare(`SELECT fts_main_content.match_bm25('a.md', ?, fields := '${field}') AS score`)).get(term)) as { score: number | null };
        if (score.score !== null) contributions.push(score.score);
      }
      if (field === 'text') assert.equal(new Set(contributions).size, 3, 'the fixture must exercise unequal floating-point contributions');
      expectedByField.push(contributions.sort((a, b) => a - b).reduce((sum, score) => sum + score, 0));
    }
    const queries = ['alpha beta gamma', 'gamma alpha beta', 'beta gamma alpha alpha'];
    for (let repetition = 0; repetition < 8; repetition++) {
      const results = await Promise.all(queries.map((terms) => query(terms, { ...BASE, limit: 10 })));
      for (const hits of results)
        assert.deepEqual(
          hits.map((hit) => hit.path),
          ['a.md', 'b.md']
        );
      for (const terms of queries) {
        const tokens = await nativeQueryTerms(conn, terms);
        const rows = (await (
          await conn.prepare(`SELECT path, ${orderedBm25Sql('title', tokens.length)} AS title, ${orderedBm25Sql('summary', tokens.length)} AS summary, ${orderedBm25Sql('text', tokens.length)} AS text FROM content WHERE path IN ('a.md', 'b.md') ORDER BY path`)
        ).all(...tokens, ...tokens, ...tokens)) as Array<{ path: string; title: number; summary: number; text: number }>;
        assert.deepEqual(
          rows.map(({ path }) => path),
          ['a.md', 'b.md']
        );
        for (const row of rows) assert.deepEqual([row.title, row.summary, row.text], expectedByField);
      }
    }
  });

  it('deduplicates stem collisions and uses native accent/digit tokenization with bound input', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', '', '', 'running generously café alpha beta');
    await insertDoc(conn, 'other.md', '', '', 'unrelated');
    await insertDoc(conn, 'digits.md', '', '', '123');
    const { query } = await preparedIndex(conn);
    assert.deepEqual(
      (await query('running runs run', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['hit.md']
    );
    assert.deepEqual(
      (await query('generously', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['hit.md']
    );
    assert.deepEqual(
      (await query('"123"', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['digits.md']
    );
    const getScore = async (terms: string) => {
      const tokens = await nativeQueryTerms(conn, terms);
      return (await conn.prepare(`SELECT ${orderedBm25Sql('text', tokens.length)} AS score FROM content WHERE path = 'hit.md'`)).get(...tokens);
    };
    const single = (await (await conn.prepare("SELECT fts_main_content.match_bm25('hit.md', 'run', fields := 'text') AS score")).get()) as { score: number };
    assert.deepEqual(await getScore('running runs run'), single);
    assert.deepEqual(await getScore('run run'), single);
    for (const terms of ['CAFÉ', 'alpha123beta'])
      assert.deepEqual(
        (await query(terms, { ...BASE, limit: 10 })).map((hit) => hit.path),
        ['hit.md']
      );
    for (const terms of ['', '123', 'absent', 'alpha absent']) assert.deepEqual(await getScore(terms), terms === 'alpha absent' ? await getScore('alpha') : { score: null });
    for (const terms of ['123', 'absent', 'alpha absent']) assert.deepEqual(await query(terms, { ...BASE, limit: 10 }), []);
    await getScore("alpha'; DROP TABLE content; --");
    assert.equal(((await (await conn.prepare('SELECT count(*) AS count FROM content')).get()) as { count: bigint }).count, BigInt(3));
  });

  it('binds native terms, substring gates and phrase parameters in their authored order', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', 'alpha', 'beta', 'gamma 天气 delta');
    await insertDoc(conn, 'missing.md', 'alpha', '', 'gamma 天气 delta');
    await insertDoc(conn, 'apart.md', 'alpha', 'beta', 'gamma delta 天气');
    const { query } = await preparedIndex(conn);
    assert.deepEqual(
      (await query('alpha beta "gamma 天气"', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['hit.md']
    );
  });

  it('handles a representative longer query without imposing a term limit', async () => {
    const conn = await makeConn();
    const terms = Array.from({ length: 64 }, (_value, i) => `word${String.fromCharCode(97 + Math.floor(i / 26), 97 + (i % 26))}z`);
    await insertDoc(conn, 'b.md', '', '', terms.join(' '));
    await insertDoc(conn, 'a.md', '', '', terms.join(' '));
    await insertDoc(conn, 'missing.md', '', '', terms.slice(1).join(' '));
    const { query } = await preparedIndex(conn);
    const tokens = await nativeQueryTerms(conn, terms.join(' '));
    assert.equal(tokens.length, 64, 'the fixture must produce 64 distinct native stems');
    for (const text of [terms.join(' '), terms.slice().reverse().join(' ')])
      assert.deepEqual(
        (await query(text, { ...BASE, limit: 10 })).map((hit) => hit.path),
        ['a.md', 'b.md']
      );
  });

  it('a matching term returns the expected path (bm25 branch)', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'Astronomy', '', 'stars and planets');
    await insertDoc(conn, 'b.md', 'Cooking', '', 'recipes and food');
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
    const hits = await query('widget', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['title-hit.md', 'body-hit.md']
    );
  });

  it('ranks otherwise identical native field scores by title, summary, then text weights', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'body.md', '', '', 'needle');
    await insertDoc(conn, 'summary.md', '', 'needle', '');
    await insertDoc(conn, 'title.md', 'needle', '', '');
    const { query } = await preparedIndex(conn);
    assert.deepEqual(
      (await query('needle', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['title.md', 'summary.md', 'body.md']
    );
  });

  it('a bare multi-word query AND-joins: one absent word means zero rows', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'both.md', '', '', 'apple and banana together');
    await insertDoc(conn, 'apple-only.md', '', '', 'just an apple here');
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
    const hits = await query('"Customer-Facing"', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['hit.md', 'spaced.md']
    );
  });

  it('a quoted punctuation-only phrase is empty, even when mixed with a word', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'hit.md', '', '', 'apple dashboard');
    const { query } = await preparedIndex(conn);
    assert.deepEqual(await query('"!!!"', { ...BASE, limit: 10 }), []);
    assert.deepEqual(await query('apple "!!!"', { ...BASE, limit: 10 }), []);
  });

  it('an unspaced-script (CJK) run is found via contains(), unquoted', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'zh.md', '', '', '今天天气非常好,适合出去散步。');
    await insertDoc(conn, 'other.md', '', '', 'unrelated english text');
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
    const hits = await query('apple', { whereJoin: '', whereCond: '', scopeCond: `AND content.path IN (SELECT "path" FROM _search_scope)`, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['in-scope.md']
    );
  });

  it('requires preparation after markStale(), then picks up the changed content', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const { query, markStale } = await preparedIndex(conn);
    assert.deepEqual(
      (await query('second', { ...BASE, limit: 10 })).map((h) => h.path),
      []
    );
    await insertDoc(conn, 'b.md', 'second', '', 'second body');
    await markStale();
    await assert.rejects(
      () => query('second', { ...BASE, limit: 10 }),
      (err: SenseError) => err.code === 'INDEX_NOT_READY'
    );
    await prepareFts(conn);
    assert.deepEqual(
      (await query('second', { ...BASE, limit: 10 })).map((h) => h.path),
      ['b.md']
    );
  });

  it('an empty terms string returns zero rows without touching the fts extension', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const { query } = await preparedIndex(conn);
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
    const { query } = await preparedIndex(conn);
    const hits = await query('foo or bar', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });

  it('does not reject a quoted phrase, even one that contains operator-shaped text', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', '', '', 'foo AND bar together');
    const { query } = await preparedIndex(conn);
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
  it('does not rebuild after mtime-only or unrelated-frontmatter reparses with identical searchable values', async () => {
    const baseDir = tmpTree();
    const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {} };
    const file = join(baseDir, 'a.md');
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Durable', summary: 'Summary', priority: 1 }, body: 'Unchanged body.' });
    const opened = await openFileConn(join(tmpTree(), 'cache.duckdb'));
    try {
      await insertDoc(opened.conn, 'a.md', 'Durable', 'Summary', 'Unchanged body.');
      await prepareFts(opened.conn);
      const rebuilds = countFtsRebuilds(opened.conn);
      const previousMtime = statSync(file).mtimeMs;
      for (const metadataChange of [false, true]) {
        if (metadataChange) writeNote(baseDir, 'a.md', { frontmatter: { title: 'Durable', summary: 'Summary', priority: 2 }, body: 'Unchanged body.' });
        const mtime = previousMtime + (metadataChange ? 20_000 : 10_000);
        utimesSync(file, mtime / 1000, mtime / 1000);
        const doc = parseFile(listFiles(cfg, baseDir)[0]).doc;
        assert.notEqual(doc.mtimeMs, previousMtime);
        assert.equal(doc.data.priority, metadataChange ? 2 : 1);
        await withTransaction(opened.conn, () => duckdbDialect.reconcileContent(opened.conn, ['a.md'], [doc], { files: [], reparsed: ['a.md'], added: [], vanished: [] }, cfg));
        assert.equal(await getMeta(opened.conn, 'fts_stale'), '0');
        await prepareFts(opened.conn);
        assert.equal(rebuilds(), 0);
        assert.deepEqual(await (await opened.conn.prepare('SELECT * FROM content')).all(), [{ path: 'a.md', title: 'Durable', summary: 'Summary', text: 'Unchanged body.' }]);
        assert.deepEqual(
          (await createLexicalIndex(opened.conn).query('durable', { ...BASE, limit: 10 })).map((row) => row.path),
          ['a.md']
        );
      }
    } finally {
      opened.close();
    }
  });

  it('an identical reparse preserves prior stale and missing-artifact recovery across connections', async () => {
    for (const recovery of ['stale', 'missing']) {
      const baseDir = tmpTree();
      const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {} };
      writeNote(baseDir, 'a.md', { frontmatter: { title: 'Recovery' }, body: 'Durable body.' });
      const doc = parseFile(listFiles(cfg, baseDir)[0]).doc;
      const dbPath = join(tmpTree(), 'cache.duckdb');
      const first = await openFileConn(dbPath);
      try {
        await insertDoc(first.conn, 'a.md', 'Recovery', '', 'Durable body.');
        await prepareFts(first.conn);
        if (recovery === 'stale') await withTransaction(first.conn, () => markContentStale(first.conn));
        else await first.conn.exec('DROP SCHEMA fts_main_content CASCADE');
      } finally {
        first.close();
      }
      const second = await openFileConn(dbPath);
      try {
        const rebuilds = countFtsRebuilds(second.conn);
        await withTransaction(second.conn, () => duckdbDialect.reconcileContent(second.conn, ['a.md'], [doc], { files: [], reparsed: ['a.md'], added: [], vanished: [] }, cfg));
        assert.equal(await getMeta(second.conn, 'fts_stale'), recovery === 'stale' ? '1' : '0');
        await prepareFts(second.conn);
        assert.equal(rebuilds(), 1, recovery);
        assert.equal(await getMeta(second.conn, 'fts_stale'), '0');
        assert.deepEqual(
          (await createLexicalIndex(second.conn).query('recovery', { ...BASE, limit: 10 })).map((row) => row.path),
          ['a.md']
        );
      } finally {
        second.close();
      }
    }
  });

  it('rebuilds exactly once for genuine title, summary, body, addition and deletion changes', async () => {
    const baseDir = tmpTree();
    const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {} };
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Original', summary: 'Initial' }, body: 'Starting body.' });
    const opened = await openFileConn(join(tmpTree(), 'cache.duckdb'));
    try {
      await insertDoc(opened.conn, 'a.md', 'Original', 'Initial', 'Starting body.');
      await prepareFts(opened.conn);
      const rebuilds = countFtsRebuilds(opened.conn);
      const changes = [
        { title: 'Retitled', summary: 'Initial', body: 'Starting body.', query: 'retitled' },
        { title: 'Retitled', summary: 'Resummarized', body: 'Starting body.', query: 'resummarized' },
        { title: 'Retitled', summary: 'Resummarized', body: 'Replacement body.', query: 'replacement' },
      ];
      for (const [i, change] of changes.entries()) {
        writeNote(baseDir, 'a.md', { frontmatter: { title: change.title, summary: change.summary }, body: change.body });
        const doc = parseFile(listFiles(cfg, baseDir)[0]).doc;
        await withTransaction(opened.conn, () => duckdbDialect.reconcileContent(opened.conn, ['a.md'], [doc], { files: [], reparsed: ['a.md'], added: [], vanished: [] }, cfg));
        assert.equal(await getMeta(opened.conn, 'fts_stale'), '1');
        await prepareFts(opened.conn);
        assert.equal(rebuilds(), i + 1);
        assert.deepEqual(
          (await createLexicalIndex(opened.conn).query(change.query, { ...BASE, limit: 10 })).map((row) => row.path),
          ['a.md']
        );
      }
      writeNote(baseDir, 'b.md', { frontmatter: { title: 'Additional' }, body: 'Added body.' });
      const addedFile = listFiles(cfg, baseDir).find((file) => file.relPath === 'b.md');
      assert.ok(addedFile);
      const added = parseFile(addedFile).doc;
      await withTransaction(opened.conn, () => duckdbDialect.reconcileContent(opened.conn, [], [added], { files: [], reparsed: ['b.md'], added: ['b.md'], vanished: [] }, cfg));
      await prepareFts(opened.conn);
      assert.equal(rebuilds(), 4);
      assert.deepEqual(
        (await createLexicalIndex(opened.conn).query('additional', { ...BASE, limit: 10 })).map((row) => row.path),
        ['b.md']
      );
      rmSync(join(baseDir, 'b.md'));
      await withTransaction(opened.conn, () => duckdbDialect.reconcileContent(opened.conn, ['b.md'], [], { files: [], reparsed: [], added: [], vanished: ['b.md'] }, cfg));
      await prepareFts(opened.conn);
      assert.equal(rebuilds(), 5);
      assert.deepEqual(
        (await createLexicalIndex(opened.conn).query('additional', { ...BASE, limit: 10 })).map((row) => row.path),
        []
      );
      assert.deepEqual(await (await opened.conn.prepare('SELECT * FROM content')).all(), [{ path: 'a.md', title: 'Retitled', summary: 'Resummarized', text: 'Replacement body.' }]);
      assert.equal(await getMeta(opened.conn, 'fts_stale'), '0');
    } finally {
      opened.close();
    }
  });

  it('detects a missing durable artifact despite a clear marker and recovers on preparation', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'artifact', '', 'durable artifact');
    await prepareFts(conn);
    assert.equal(await getMeta(conn, 'fts_stale'), '0');
    await conn.exec('DROP SCHEMA fts_main_content CASCADE');

    await assert.rejects(
      () => assertFtsReady(conn),
      (err: SenseError) => {
        assert.equal(err.code, 'INDEX_NOT_READY');
        assert.match(err.message, /artifact is missing/);
        return true;
      }
    );

    await prepareFts(conn);
    await assert.doesNotReject(() => assertFtsReady(conn));
    assert.deepEqual(
      (await createLexicalIndex(conn).query('artifact', { ...BASE, limit: 10 })).map((row) => row.path),
      ['a.md']
    );
  });

  it('a second connection over an unchanged cache does not rebuild', async () => {
    const dbPath = join(tmpTree(), 'cache.duckdb');
    const first = await openFileConn(dbPath);
    await insertDoc(first.conn, 'a.md', 'first', '', 'first body');
    await (await preparedIndex(first.conn)).query('first', { ...BASE, limit: 10 });
    assert.equal(await getMeta(first.conn, 'fts_stale'), '0');
    first.close();

    const second = await openFileConn(dbPath);
    assert.equal(await getMeta(second.conn, 'fts_stale'), '0', "the clear must have persisted to disk, not just this connection's memory");
    const rebuilds = countFtsRebuilds(second.conn);
    const secondIndex = await preparedIndex(second.conn);
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
    second.close();
  });

  it('content changed between connections does rebuild', async () => {
    const dbPath = join(tmpTree(), 'cache.duckdb');
    const first = await openFileConn(dbPath);
    await insertDoc(first.conn, 'a.md', 'first', '', 'first body');
    await (await preparedIndex(first.conn)).query('first', { ...BASE, limit: 10 });
    first.close();

    const second = await openFileConn(dbPath);
    await insertDoc(second.conn, 'b.md', 'second', '', 'second body');
    // Mirrors what reconcileContent (reconcile.ts) does inside its own transaction when content changes.
    await markContentStale(second.conn);
    const rebuilds = countFtsRebuilds(second.conn);
    await prepareFts(second.conn);
    const hits = await createLexicalIndex(second.conn).query('second', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['b.md']
    );
    assert.equal(rebuilds(), 1, 'changed content must rebuild exactly once');
    assert.equal(await getMeta(second.conn, 'fts_stale'), '0');
    second.close();
  });

  it('uses the rebuilt native index through the same lexical handle', async () => {
    const conn = await makeConn();
    await insertDoc(conn, 'a.md', 'first', '', 'first body');
    const index = await preparedIndex(conn);
    await index.query('first', { ...BASE, limit: 10 });
    await insertDoc(conn, 'b.md', 'second', '', 'second body');
    await markContentStale(conn);
    await prepareFts(conn);
    assert.deepEqual(
      (await index.query('second', { ...BASE, limit: 10 })).map((hit) => hit.path),
      ['b.md']
    );
  });
});
