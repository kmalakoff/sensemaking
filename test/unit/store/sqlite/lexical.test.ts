import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { createConnection } from '../../../../src/store/sqlite/connection.ts';
import { queryLexical } from '../../../../src/store/sqlite/lexical.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { segmentField } from '../../../../src/text/segment.ts';

function makeDb(): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = 'porter unicode61')`);
  return { db, conn: createConnection(db) };
}

function insertDoc(db: DatabaseSync, path: string, title: string, summary: string, text: string): void {
  db.prepare('INSERT INTO content (title, summary, text, path, title_seg, summary_seg, text_seg) VALUES (?, ?, ?, ?, ?, ?, ?)').run(title, summary, text, path, '', '', '');
}

function insertSegmented(db: DatabaseSync, path: string, text: string): void {
  db.prepare('INSERT INTO content (title, summary, text, path, title_seg, summary_seg, text_seg) VALUES (?, ?, ?, ?, ?, ?, ?)').run('', '', text, path, '', '', segmentField(text));
}

const BASE = { whereJoin: '', whereCond: '', scopeCond: '' };

describe('queryLexical', () => {
  it('a matching term returns the expected path', async () => {
    const { db, conn } = makeDb();
    insertDoc(db, 'a.md', 'Astronomy', '', 'stars and planets');
    insertDoc(db, 'b.md', 'Cooking', '', 'recipes and food');
    const hits = await queryLexical(conn, 'astronomy', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['a.md']
    );
  });

  it('a title hit outranks a body-only hit (column weighting)', async () => {
    const { db, conn } = makeDb();
    insertDoc(db, 'title-hit.md', 'widget', '', 'nothing else relevant here');
    insertDoc(db, 'body-hit.md', 'unrelated', '', 'a widget is mentioned only in passing here');
    const hits = await queryLexical(conn, 'widget', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['title-hit.md', 'body-hit.md']
    );
  });

  it('includes an excerpt for a doc under the snippet bound, and NULL past it', async () => {
    const { db, conn } = makeDb();
    insertDoc(db, 'short.md', 'short', '', 'needle in a short haystack');
    // SNIPPET_BOUND is 16384 chars; well past it so `hit` must be NULL rather than attempt
    // the superlinear snippet() call.
    const long = `${'padding '.repeat(3000)} needle`;
    insertDoc(db, 'long.md', 'long', '', long);

    const hits = await queryLexical(conn, 'needle', { ...BASE, limit: 10 });
    const shortHit = hits.find((h) => h.path === 'short.md');
    const longHit = hits.find((h) => h.path === 'long.md');

    assert.ok(shortHit);
    assert.notEqual(shortHit?.hit, null);
    assert.match(shortHit?.hit as string, /needle/);

    assert.ok(longHit);
    assert.equal(longHit?.hit, null, 'a doc whose text exceeds SNIPPET_BOUND should get a NULL hit');
  });

  it('narrows results by the caller-built scope condition', async () => {
    const { db, conn } = makeDb();
    insertDoc(db, 'in-scope.md', 'apple', '', 'apple pie');
    insertDoc(db, 'out-of-scope.md', 'apple', '', 'apple tart');
    db.exec(`CREATE TEMP TABLE _search_scope ("path" TEXT)`);
    db.exec(`INSERT INTO _search_scope VALUES ('in-scope.md')`);

    const hits = await queryLexical(conn, 'apple', { whereJoin: '', whereCond: '', scopeCond: `AND content.path IN (SELECT "path" FROM _search_scope)`, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['in-scope.md']
    );
  });

  it('segments an unspaced-script run into a grapheme phrase against the _seg sidecars', async () => {
    const { db, conn } = makeDb();
    insertSegmented(db, 'zh.md', '你好世界');
    const hits = await queryLexical(conn, '你好', { ...BASE, limit: 10 });
    assert.deepEqual(
      hits.map((h) => h.path),
      ['zh.md']
    );
  });
});
