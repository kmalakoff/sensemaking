import assert from 'node:assert';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { linkEdges } from '../../src/features/links.ts';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

describe('links: embed vs link grain', () => {
  it('[[a]] is embed=0, ![[a]] is embed=1, and both in one note give two rows sharing dst', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and also ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target, dst, embed FROM links WHERE src = ? ORDER BY embed').all('a.md') as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { target: 'b', dst: 'b.md', embed: 0 },
      { target: 'b', dst: 'b.md', embed: 1 },
    ]);
  });

  it('markdown forms: [text](a.md) is embed=0, ![alt](a.md) is embed=1', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'A [link](b.md) and an ![image](b.md).' });
    writeNote(baseDir, 'b.md', { body: 'target' });

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target, dst, embed FROM links WHERE src = ? ORDER BY embed').all('a.md') as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { target: 'b.md', dst: 'b.md', embed: 0 },
      { target: 'b.md', dst: 'b.md', embed: 1 },
    ]);
  });

  it('a dual link+embed pair collapses to one edge, and rank computes without error', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'hub.md', { body: 'the hub' });
    writeNote(baseDir, 'a.md', { body: 'See [[hub]] and also ![[hub]].' });

    const { db } = openTree(baseDir);
    const distinctEdges = db.prepare('SELECT DISTINCT src, dst FROM links WHERE dst IS NOT NULL').all() as Array<{ src: string; dst: string }>;
    assert.deepEqual(distinctEdges, [{ src: 'a.md', dst: 'hub.md' }]);
    assert.deepEqual(linkEdges(db), [['a.md', 'hub.md']]);

    const ranks = db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC').all() as Array<{ path: string; _rank: number }>;
    assert.equal(ranks[0].path, 'hub.md');
  });

  it('a dead embed has dst NULL and embed=1', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'Embeds ![[missing]] before it exists.' });

    const { db } = openTree(baseDir);
    const row = db.prepare('SELECT dst, embed FROM links WHERE src = ?').get('a.md') as { dst: string | null; embed: number };
    assert.equal(row.dst, null);
    assert.equal(row.embed, 1);
  });

  it('editing a note from ![[a]] to [[a]] flips the row on reopen', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'target' });
    writeNote(baseDir, 'src.md', { body: 'Embeds ![[a]].' });

    const first = openTree(baseDir);
    const before = first.db.prepare('SELECT target, dst, embed FROM links WHERE src = ?').all('src.md') as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(before, [{ target: 'a', dst: 'a.md', embed: 1 }]);
    first.db.close();

    const future = new Date(Date.now() + 5000);
    writeNote(baseDir, 'src.md', { body: 'Links [[a]] now.' });
    utimesSync(join(baseDir, 'src.md'), future, future);

    const second = openTree(baseDir);
    const after = second.db.prepare('SELECT target, dst, embed FROM links WHERE src = ?').all('src.md') as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(after, [{ target: 'a', dst: 'a.md', embed: 0 }]);
    second.db.close();
  });

  it('adding a link beside an already-resolved embed resolves the new row incrementally', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '![[b]]' });
    writeNote(baseDir, 'b.md', { body: 'leaf' });
    const first = openTree(baseDir);
    first.db.close();

    // Touch only a.md: an incremental reconcile, far under the full-pass threshold.
    writeNote(baseDir, 'a.md', { body: '![[b]] and [[b]]' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT embed, dst FROM links WHERE src = 'a.md' ORDER BY embed`).all() as Array<{ embed: number; dst: string | null }>;
    assert.deepEqual(rows, [
      { embed: 0, dst: 'b.md' },
      { embed: 1, dst: 'b.md' },
    ]);
    db.close();
  });
});
