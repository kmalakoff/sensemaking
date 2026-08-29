import assert from 'assert';
import { openTree, tmpTree, writeNote } from '../../../lib/tree.ts';

describe('basename()', () => {
  it('strips directories, and a suffix argument Unix-style', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'notes/Deep Note.md', { frontmatter: { title: 'D' } });
    const { store } = await openTree(baseDir);
    const q = async (sql: string) => ((await (await store.prepare(sql)).get()) as { v: unknown }).v;
    assert.equal(await q(`SELECT basename("path") AS v FROM frontmatter`), 'Deep Note.md');
    assert.equal(await q(`SELECT basename("path", '.md') AS v FROM frontmatter`), 'Deep Note');
    // Unix basename: a suffix equal to the whole name is not stripped, trailing slash drops.
    assert.equal(await q(`SELECT basename('.md', '.md') AS v`), '.md');
    assert.equal(await q(`SELECT basename('notes/') AS v`), 'notes');
    assert.equal(await q('SELECT basename(NULL) AS v'), null);
    await store.close();
  });
});
