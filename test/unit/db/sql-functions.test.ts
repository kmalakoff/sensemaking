import assert from 'node:assert';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

describe('basename()', () => {
  it('strips directories, and a suffix argument Unix-style', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'notes/Deep Note.md', { frontmatter: { title: 'D' } });
    const { db } = openTree(baseDir);
    const q = (sql: string) => (db.prepare(sql).get() as { v: unknown }).v;
    assert.equal(q(`SELECT basename("path") AS v FROM frontmatter`), 'Deep Note.md');
    assert.equal(q(`SELECT basename("path", '.md') AS v FROM frontmatter`), 'Deep Note');
    // Unix basename: a suffix equal to the whole name is not stripped, trailing slash drops.
    assert.equal(q(`SELECT basename('.md', '.md') AS v`), '.md');
    assert.equal(q(`SELECT basename('notes/') AS v`), 'notes');
    assert.equal(q('SELECT basename(NULL) AS v'), null);
    db.close();
  });
});
