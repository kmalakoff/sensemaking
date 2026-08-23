import assert from 'node:assert';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

describe('_ctime core column', () => {
  it('every row carries the file birthtime, and the key is reserved', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { db, warnings } = openTree(baseDir);
    const row = db.prepare(`SELECT "_ctime", "_mtime" FROM frontmatter WHERE "path" = 'a.md'`).get() as { _ctime: number; _mtime: number };
    assert.equal(typeof row._ctime, 'number');
    assert.ok(row._ctime > 0 && row._ctime <= row._mtime, 'birthtime precedes or equals mtime');
    db.close();

    // Reserved: an author-written _ctime is dropped with a warning, not stored.
    writeNote(baseDir, 'b.md', { frontmatter: '_ctime: 123' });
    const second = openTree(baseDir);
    const b = second.db.prepare(`SELECT "_ctime" FROM frontmatter WHERE "path" = 'b.md'`).get() as { _ctime: number };
    assert.notEqual(b._ctime, 123);
    assert.ok([...warnings, ...second.warnings].every((w) => typeof w === 'string'));
    second.db.close();
  });

  it('map does not list _ctime as a frontmatter field', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { db, cfg } = openTree(baseDir);
    const { mapTree } = await import('sensemaking');
    const fields = mapTree(db, cfg).fields.map((f) => f.field);
    assert.ok(!fields.includes('_ctime'), `internal column leaked: ${fields.join(', ')}`);
    db.close();
  });
});

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
