import assert from 'assert';
import { getMeta, setMeta } from '../../../src/store/meta.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

describe('getMeta/setMeta', () => {
  it('a missing key reads as null', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    assert.equal(await getMeta(store, 'nope'), null);
    await store.close();
  });

  it('setMeta inserts a new key, and getMeta round-trips the exact value', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    await setMeta(store, 'custom', 'hello');
    assert.equal(await getMeta(store, 'custom'), 'hello');
    await store.close();
  });

  it('setMeta overwrites an existing key (upsert), not inserting a duplicate row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    await setMeta(store, 'custom', 'first');
    await setMeta(store, 'custom', 'second');
    assert.equal(await getMeta(store, 'custom'), 'second');
    const count = ((await (await store.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?')).get('custom')) as { n: number }).n;
    assert.equal(count, 1, 'an overwrite must not leave a second row for the same key');
    await store.close();
  });

  it('setMeta with a null value deletes the key rather than storing NULL', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store } = await openTree(baseDir);
    await setMeta(store, 'custom', 'value');
    await setMeta(store, 'custom', null);
    assert.equal(await getMeta(store, 'custom'), null);
    const count = ((await (await store.prepare('SELECT COUNT(*) AS n FROM meta WHERE key = ?')).get('custom')) as { n: number }).n;
    assert.equal(count, 0, 'the row should be deleted, not left behind with a NULL value');
    await store.close();
  });
});
