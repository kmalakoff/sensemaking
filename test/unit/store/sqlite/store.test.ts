import assert from 'assert';
import { openTree, tmpTree, writeNote } from '../../../lib/tree.ts';

describe('createStore (sqlite)', () => {
  it('declares its name and capability set', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    assert.equal(store.name, 'sqlite');
    assert.deepEqual([...store.capabilities].sort(), ['lexical', 'phrases', 'snippets', 'vectors', 'watch-concurrency']);
    await store.close();
  });

  it('docs.columns() returns frontmatter column names', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const { store } = await openTree(baseDir);
    const columns = await store.docs.columns();
    assert.ok(columns.includes('title'), `expected 'title' among ${columns.join(', ')}`);
    assert.ok(columns.includes('tags'), `expected 'tags' among ${columns.join(', ')}`);
    assert.ok(columns.includes('path'));
    await store.close();
  });

  it('raw.prepare() streams rows through its async iterator', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const { store } = await openTree(baseDir);
    const stmt = await store.raw.prepare('SELECT "path" FROM frontmatter ORDER BY "path"');
    const rows: unknown[] = [];
    for await (const row of stmt.iterate()) rows.push(row);
    assert.deepEqual(rows, [{ path: 'a.md' }, { path: 'b.md' }]);
    await store.close();
  });

  it('raw.prepare() reads int64 values past 2^53 as BigInt instead of throwing', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    const stmt = await store.raw.prepare('SELECT 9007199254740993 AS big'); // 2^53 + 9, past safe-integer range
    const rows: Array<{ big: unknown }> = [];
    for await (const row of stmt.iterate()) rows.push(row as { big: unknown });
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].big, 'bigint');
    assert.equal(rows[0].big, BigInt('9007199254740993'));
    await store.close();
  });
});
