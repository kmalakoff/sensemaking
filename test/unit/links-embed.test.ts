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

  it('two written targets resolving to one dst stay two edges', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[[Foo]] and [[notes/Foo]]' });
    writeNote(baseDir, 'notes/Foo.md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    // The doubled weight is deliberate and the fusion evals are gated on it; a dedup here is
    // the regression this asserts against.
    assert.deepEqual(
      linkEdges(db)
        .filter(([src]) => src === 'a.md')
        .map(([, dst]) => dst),
      ['notes/Foo.md', 'notes/Foo.md']
    );
    db.close();
  });

  it('a heading or alias holding a lone ] still parses to the first ]]', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[Other#Steps [WIP] more]] and [[Other|see [1]]]' });
    writeNote(baseDir, 'Other.md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT dst FROM links WHERE src = 'a.md'`).all() as Array<{ dst: string | null }>;
    assert.deepEqual(
      rows.map((r) => r.dst),
      ['Other.md'],
      'one distinct target, resolved, not silently dropped'
    );
    db.close();
  });

  it('a commented-out wikilink (single-line) produces no row', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'before <!-- [[b]] --> after' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target FROM links WHERE src = ?').all('a.md');
    assert.deepEqual(rows, []);
    db.close();
  });

  it('a commented-out wikilink (multi-line) produces no row', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'before\n<!-- comment\n[[b]]\nstill comment -->\nafter' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target FROM links WHERE src = ?').all('a.md');
    assert.deepEqual(rows, []);
    db.close();
  });

  it('a wikilink inside a fenced block produces no row', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '```\n[[b]]\n```\n' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target FROM links WHERE src = ?').all('a.md');
    assert.deepEqual(rows, []);
    db.close();
  });

  it('a real link on a line adjacent to a comment still resolves', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '<!-- [[hidden]] -->\n[[b]]' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    writeNote(baseDir, 'hidden.md', { body: 'target' });
    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT target, dst FROM links WHERE src = ?').all('a.md') as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: 'b', dst: 'b.md' }]);
    db.close();
  });

  it('[[#Heading]] is a resolved self-edge, and ![[#x]] is a self-edge embed', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Heading One]] and embed ![[#x]]' });
    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT src, target, dst, embed FROM links WHERE src = ? ORDER BY embed').all('a.md') as Array<{ src: string; target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: '#Heading One', dst: 'a.md', embed: 0 },
      { src: 'a.md', target: '#x', dst: 'a.md', embed: 1 },
    ]);
    db.close();
  });

  it('linkEdges() excludes the self-edge while the table keeps the row', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Heading One]] and also [[b]]' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { db } = openTree(baseDir);
    const tableRows = db.prepare('SELECT dst FROM links WHERE src = ? AND target = ?').all('a.md', '#Heading One');
    assert.deepEqual(tableRows, [{ dst: 'a.md' }]);
    assert.deepEqual(linkEdges(db), [['a.md', 'b.md']]);
    db.close();
  });

  it('two files colliding on basename resolve to the shorter path', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'Themes/Blur.md', { body: 'short' });
    writeNote(baseDir, 'Plugins/Extra/Blur.md', { body: 'long' });
    writeNote(baseDir, 'a.md', { body: '[[Blur]]' });
    const { db } = openTree(baseDir);
    const row = db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(row.dst, 'Themes/Blur.md');
    db.close();
  });

  it('two files colliding on basename at equal path length fall back to lexicographic', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'zzz/Foo.md', { body: 'z' });
    writeNote(baseDir, 'aaa/Foo.md', { body: 'a' });
    writeNote(baseDir, 'a.md', { body: '[[Foo]]' });
    const { db } = openTree(baseDir);
    const row = db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(row.dst, 'aaa/Foo.md');
    db.close();
  });

  it('an inline code span hides its wikilink', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'use `[[NotALink]]` syntax, see [[Real]]' });
    writeNote(baseDir, 'Real.md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT target FROM links WHERE src = 'a.md' ORDER BY target`).all() as Array<{ target: string }>;
    assert.deepEqual(
      rows.map((r) => r.target),
      ['Real']
    );
    db.close();
  });

  it('the linking note itself wins a basename collision', () => {
    const baseDir = tmpTree();
    // Case-mismatched self, so no exact-path candidate fires and the byBase fallback decides.
    writeNote(baseDir, 'deep/dir/self.md', { body: 'alias-style [[Self]] mention' });
    writeNote(baseDir, 'x/Self.md', { body: 'shorter path elsewhere' });
    const { db } = openTree(baseDir);
    const row = db.prepare(`SELECT dst FROM links WHERE src = 'deep/dir/self.md'`).get() as { dst: string };
    assert.equal(row.dst, 'deep/dir/self.md', 'self beats the shorter path');
    db.close();
  });

  it('markdown links get full linkpath semantics', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', {
      body: '[person](Zektor) and [self](#anchor) and [dead](placeholder/link) and [ext](https://x.com/y.md) and [bad]((https://x.com/z.md) and [sp](github repo words) and [dom](www.site.com/page) end',
    });
    writeNote(baseDir, 'people/Zektor.md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`).all() as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: '#anchor', dst: 'a.md' },
      { target: 'Zektor', dst: 'people/Zektor.md' },
      { target: 'placeholder/link', dst: null },
    ]);
    db.close();
  });

  it('frontmatter values that are exactly a wikilink are links', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', {
      frontmatter: { projects: ['[[Rhino]]', 'plain'], whole: '[[Rhino|Alias]]', mixed: 'pre [[Rhino]] post', embedForm: '![[Rhino]]', missing: '[[Nope]]' },
      body: 'body',
    });
    writeNote(baseDir, 'Rhino.md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`).all() as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'Nope', dst: null },
      { target: 'Rhino', dst: 'Rhino.md' },
    ]);
    db.close();
  });

  it('self-edges stay out of peek-style views but in the table', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Head]]\n\n# Head' });
    const { db } = openTree(baseDir);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM links WHERE src = 'a.md' AND dst = 'a.md'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = 'a.md' AND src != dst`).get() as { n: number }).n, 0, 'backlinks view excludes self, as Obsidian does');
    db.close();
  });

  it('a dotted folder resolves; www. and schemes are external', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[in](dir.v2/Note) [w](www.site.com/x) [nest](note_(1).md)' });
    writeNote(baseDir, 'dir.v2/Note.md', { body: 'leaf' });
    writeNote(baseDir, 'note_(1).md', { body: 'leaf' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`).all() as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'dir.v2/Note', dst: 'dir.v2/Note.md' },
      { target: 'note_(1).md', dst: 'note_(1).md' },
    ]);
    db.close();
  });

  it('frontmatter [[#]] with no heading name is not a link', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { odd: '[[#]]', anchored: '[[#Real Head]]' }, body: 'body' });
    const { db } = openTree(baseDir);
    const rows = db.prepare(`SELECT target, dst FROM links WHERE src = 'a.md'`).all() as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: '#Real Head', dst: 'a.md' }]);
    db.close();
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
