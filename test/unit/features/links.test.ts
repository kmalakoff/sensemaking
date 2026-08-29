import assert from 'node:assert';
import { mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { clearCache, open } from 'sensemaking';
import { LINK_EDGES_SQL, toEdges } from '../../../src/features/links.ts';
import type { Store } from '../../../src/store/types.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

// linkEdges() itself takes a Connection (reconcile's own internal handle); tests reach the
// same query the way an external caller (commands/signals.ts) does, through the Store.
async function linkEdges(store: Store): Promise<[string, string][]> {
  const stmt = await store.prepare(LINK_EDGES_SQL);
  return toEdges((await stmt.all()) as Array<{ src: string; dst: string }>);
}

describe('links: embed vs link grain', () => {
  it('[[a]] is embed=0, ![[a]] is embed=1, and both in one note give two rows sharing dst', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and also ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { target: 'b', dst: 'b.md', embed: 0 },
      { target: 'b', dst: 'b.md', embed: 1 },
    ]);
  });

  it('markdown forms: [text](a.md) is embed=0, ![alt](a.md) is embed=1', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'A [link](b.md) and an ![image](b.md).' });
    writeNote(baseDir, 'b.md', { body: 'target' });

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { target: 'b.md', dst: 'b.md', embed: 0 },
      { target: 'b.md', dst: 'b.md', embed: 1 },
    ]);
  });

  it('a dual link+embed pair collapses to one edge, and rank computes without error', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'hub.md', { body: 'the hub' });
    writeNote(baseDir, 'a.md', { body: 'See [[hub]] and also ![[hub]].' });

    const { store } = await openTree(baseDir);
    const distinctEdges = (await (await store.prepare('SELECT DISTINCT src, dst FROM links WHERE dst IS NOT NULL')).all()) as Array<{ src: string; dst: string }>;
    assert.deepEqual(distinctEdges, [{ src: 'a.md', dst: 'hub.md' }]);
    assert.deepEqual(await linkEdges(store), [['a.md', 'hub.md']]);

    const ranks = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC')).all()) as Array<{ path: string; _rank: number }>;
    assert.equal(ranks[0].path, 'hub.md');
  });

  it('a dead embed has dst NULL and embed=1', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'Embeds ![[missing]] before it exists.' });

    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare('SELECT dst, embed FROM links WHERE src = ?')).get('a.md')) as { dst: string | null; embed: number };
    assert.equal(row.dst, null);
    assert.equal(row.embed, 1);
  });

  it('editing a note from ![[a]] to [[a]] flips the row on reopen', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'target' });
    writeNote(baseDir, 'src.md', { body: 'Embeds ![[a]].' });

    const first = await openTree(baseDir);
    const before = (await (await first.store.prepare('SELECT target, dst, embed FROM links WHERE src = ?')).all('src.md')) as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(before, [{ target: 'a', dst: 'a.md', embed: 1 }]);
    await first.store.close();

    const future = new Date(Date.now() + 5000);
    writeNote(baseDir, 'src.md', { body: 'Links [[a]] now.' });
    utimesSync(join(baseDir, 'src.md'), future, future);

    const second = await openTree(baseDir);
    const after = (await (await second.store.prepare('SELECT target, dst, embed FROM links WHERE src = ?')).all('src.md')) as Array<{ target: string; dst: string | null; embed: number }>;
    assert.deepEqual(after, [{ target: 'a', dst: 'a.md', embed: 0 }]);
    await second.store.close();
  });

  it('two written targets resolving to one dst stay two edges', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[[Foo]] and [[notes/Foo]]' });
    writeNote(baseDir, 'notes/Foo.md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    // The doubled weight is deliberate and the fusion evals are gated on it; a dedup here is
    // the regression this asserts against.
    assert.deepEqual(
      (await linkEdges(store)).filter(([src]) => src === 'a.md').map(([, dst]) => dst),
      ['notes/Foo.md', 'notes/Foo.md']
    );
    await store.close();
  });

  it('a heading or alias holding a lone ] still parses to the first ]]', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[Other#Steps [WIP] more]] and [[Other|see [1]]]' });
    writeNote(baseDir, 'Other.md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT dst FROM links WHERE src = 'a.md'`)).all()) as Array<{ dst: string | null }>;
    assert.deepEqual(
      rows.map((r) => r.dst),
      ['Other.md'],
      'one distinct target, resolved, not silently dropped'
    );
    await store.close();
  });

  it('a commented-out wikilink (single-line) produces no row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'before <!-- [[b]] --> after' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = await (await store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md');
    assert.deepEqual(rows, []);
    await store.close();
  });

  it('a commented-out wikilink (multi-line) produces no row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'before\n<!-- comment\n[[b]]\nstill comment -->\nafter' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = await (await store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md');
    assert.deepEqual(rows, []);
    await store.close();
  });

  it('a wikilink inside a fenced block produces no row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '```\n[[b]]\n```\n' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = await (await store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md');
    assert.deepEqual(rows, []);
    await store.close();
  });

  it('a real link on a line adjacent to a comment still resolves', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '<!-- [[hidden]] -->\n[[b]]' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    writeNote(baseDir, 'hidden.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: 'b', dst: 'b.md' }]);
    await store.close();
  });

  it('[[#Heading]] is a resolved self-edge, and ![[#x]] is a self-edge embed', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Heading One]] and embed ![[#x]]' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT src, target, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<{ src: string; target: string; dst: string | null; embed: number }>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: '#Heading One', dst: 'a.md', embed: 0 },
      { src: 'a.md', target: '#x', dst: 'a.md', embed: 1 },
    ]);
    await store.close();
  });

  it('linkEdges() excludes the self-edge while the table keeps the row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Heading One]] and also [[b]]' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const tableRows = await (await store.prepare('SELECT dst FROM links WHERE src = ? AND target = ?')).all('a.md', '#Heading One');
    assert.deepEqual(tableRows, [{ dst: 'a.md' }]);
    assert.deepEqual(await linkEdges(store), [['a.md', 'b.md']]);
    await store.close();
  });

  it('two files colliding on basename resolve to the shorter path', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'Themes/Blur.md', { body: 'short' });
    writeNote(baseDir, 'Plugins/Extra/Blur.md', { body: 'long' });
    writeNote(baseDir, 'a.md', { body: '[[Blur]]' });
    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare('SELECT dst FROM links WHERE src = ?')).get('a.md')) as { dst: string | null };
    assert.equal(row.dst, 'Themes/Blur.md');
    await store.close();
  });

  it('two files colliding on basename at equal path length fall back to lexicographic', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'zzz/Foo.md', { body: 'z' });
    writeNote(baseDir, 'aaa/Foo.md', { body: 'a' });
    writeNote(baseDir, 'a.md', { body: '[[Foo]]' });
    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare('SELECT dst FROM links WHERE src = ?')).get('a.md')) as { dst: string | null };
    assert.equal(row.dst, 'aaa/Foo.md');
    await store.close();
  });

  it('an inline code span hides its wikilink', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'use `[[NotALink]]` syntax, see [[Real]]' });
    writeNote(baseDir, 'Real.md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT target FROM links WHERE src = 'a.md' ORDER BY target`)).all()) as Array<{ target: string }>;
    assert.deepEqual(
      rows.map((r) => r.target),
      ['Real']
    );
    await store.close();
  });

  it('the linking note itself wins a basename collision', async () => {
    const baseDir = tmpTree();
    // Case-mismatched self, so no exact-path candidate fires and the byBase fallback decides.
    writeNote(baseDir, 'deep/dir/self.md', { body: 'alias-style [[Self]] mention' });
    writeNote(baseDir, 'x/Self.md', { body: 'shorter path elsewhere' });
    const { store } = await openTree(baseDir);
    const row = (await (await store.prepare(`SELECT dst FROM links WHERE src = 'deep/dir/self.md'`)).get()) as { dst: string };
    assert.equal(row.dst, 'deep/dir/self.md', 'self beats the shorter path');
    await store.close();
  });

  it('markdown links get full linkpath semantics', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', {
      body: '[person](Zektor) and [self](#anchor) and [dead](placeholder/link) and [ext](https://x.com/y.md) and [bad]((https://x.com/z.md) and [sp](github repo words) and [dom](www.site.com/page) end',
    });
    writeNote(baseDir, 'people/Zektor.md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`)).all()) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: '#anchor', dst: 'a.md' },
      { target: 'Zektor', dst: 'people/Zektor.md' },
      { target: 'placeholder/link', dst: null },
    ]);
    await store.close();
  });

  it('frontmatter values that are exactly a wikilink are links', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', {
      frontmatter: { projects: ['[[Rhino]]', 'plain'], whole: '[[Rhino|Alias]]', mixed: 'pre [[Rhino]] post', embedForm: '![[Rhino]]', missing: '[[Nope]]' },
      body: 'body',
    });
    writeNote(baseDir, 'Rhino.md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`)).all()) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'Nope', dst: null },
      { target: 'Rhino', dst: 'Rhino.md' },
    ]);
    await store.close();
  });

  it('self-edges stay out of peek-style views but in the table', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'see [[#Head]]\n\n# Head' });
    const { store } = await openTree(baseDir);
    assert.equal(((await (await store.prepare(`SELECT COUNT(*) n FROM links WHERE src = 'a.md' AND dst = 'a.md'`)).get()) as { n: number }).n, 1);
    assert.equal(((await (await store.prepare(`SELECT COUNT(DISTINCT src) AS n FROM links WHERE dst = 'a.md' AND src != dst`)).get()) as { n: number }).n, 0, 'backlinks view excludes self, as Obsidian does');
    await store.close();
  });

  it('a dotted folder resolves; www. and schemes are external', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '[in](dir.v2/Note) [w](www.site.com/x) [nest](note_(1).md) [m](mailto:a@b.com) [t](tel:+1555) [p](//host/x) [d](data:text/plain,x)' });
    writeNote(baseDir, 'dir.v2/Note.md', { body: 'leaf' });
    writeNote(baseDir, 'note_(1).md', { body: 'leaf' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT target, dst FROM links WHERE src = 'a.md' ORDER BY target`)).all()) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'dir.v2/Note', dst: 'dir.v2/Note.md' },
      { target: 'note_(1).md', dst: 'note_(1).md' },
    ]);
    await store.close();
  });

  it('frontmatter [[#]] with no heading name is not a link', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { odd: '[[#]]', anchored: '[[#Real Head]]' }, body: 'body' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT target, dst FROM links WHERE src = 'a.md'`)).all()) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: '#Real Head', dst: 'a.md' }]);
    await store.close();
  });

  it('a wikilink inside a <div> HTML block produces no row', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '<div>\n[[Link]]\n</div>' });
    writeNote(baseDir, 'Link.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = await (await store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md');
    assert.deepEqual(rows, []);
    await store.close();
  });

  it('an unclosed comment inside a <div> block does not swallow a link after the block', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '<div>\n<!-- unclosed\n</div>\n\n#afterTag\n[[AfterLink]]' });
    writeNote(baseDir, 'AfterLink.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: 'AfterLink', dst: 'AfterLink.md' }]);
    await store.close();
  });

  it('a paragraph-level unclosed comment dies at the blank line, so a link after it still resolves', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'before\n<!-- unclosed\nstill hidden\n\n[[AfterLink]]' });
    writeNote(baseDir, 'AfterLink.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: 'AfterLink', dst: 'AfterLink.md' }]);
    await store.close();
  });

  it('a closed comment inside a <div> block leaves a link after the block intact', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '<div>\n<!-- hidden -->\n</div>\n\n[[AfterLink]]' });
    writeNote(baseDir, 'AfterLink.md', { body: 'target' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [{ target: 'AfterLink', dst: 'AfterLink.md' }]);
    await store.close();
  });

  it('adding a link beside an already-resolved embed resolves the new row incrementally', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '![[b]]' });
    writeNote(baseDir, 'b.md', { body: 'leaf' });
    const first = await openTree(baseDir);
    await first.store.close();

    // Touch only a.md: an incremental reconcile, far under the full-pass threshold.
    writeNote(baseDir, 'a.md', { body: '![[b]] and [[b]]' });
    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare(`SELECT embed, dst FROM links WHERE src = 'a.md' ORDER BY embed`)).all()) as Array<{ embed: number; dst: string | null }>;
    assert.deepEqual(rows, [
      { embed: 0, dst: 'b.md' },
      { embed: 1, dst: 'b.md' },
    ]);
    await store.close();
  });
});

describe('links feature', () => {
  it('wikilinks resolve by basename; aliases, anchors, and embeds are handled', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]], [[b#section|the alias]], and ![[c]].');
    write(baseDir, 'b.md', 'target one');
    write(baseDir, 'c.md', 'target two');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT target, dst FROM links WHERE src = ? ORDER BY target')).all('a.md')) as Array<{ target: string; dst: string | null }>;
    assert.deepEqual(rows, [
      { target: 'b', dst: 'b.md' },
      { target: 'c', dst: 'c.md' },
    ]);
  });

  it('relative markdown links resolve; external URLs are ignored', async () => {
    const baseDir = tmpTree();
    mkdirSync(join(baseDir, 'sub'));
    write(baseDir, 'sub/a.md', '[sibling](b.md) and [outside](https://example.com/x.md)');
    write(baseDir, 'sub/b.md', 'target');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT dst FROM links WHERE src = ?')).all('sub/a.md')) as Array<{ dst: string | null }>;
    assert.deepEqual(
      rows.map((r) => r.dst),
      ['sub/b.md']
    );
  });

  it('a dead link has NULL dst, and resolves when the target appears later', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'Mentions [[future-note]] before it exists.');

    const first = await openTree(baseDir);
    const dead = (await (await first.store.prepare('SELECT dst FROM links WHERE src = ?')).get('a.md')) as { dst: string | null };
    assert.equal(dead.dst, null);
    await first.store.close();

    write(baseDir, 'future-note.md', 'now it exists');
    const second = await openTree(baseDir);
    const live = (await (await second.store.prepare('SELECT dst FROM links WHERE src = ?')).get('a.md')) as { dst: string | null };
    assert.equal(live.dst, 'future-note.md');
    await second.store.close();
  });

  it('deleting a target turns its backlinks back into dead links', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'Links to [[b]].');
    write(baseDir, 'b.md', 'target');

    const first = await openTree(baseDir);
    await first.store.close();

    rmSync(join(baseDir, 'b.md'));
    const second = await openTree(baseDir);
    const row = (await (await second.store.prepare('SELECT dst FROM links WHERE src = ?')).get('a.md')) as { dst: string | null };
    assert.equal(row.dst, null);
    await second.store.close();
  });

  it('disabled: no links table', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]].');
    write(baseDir, 'b.md', 'target');

    const { store } = await openTree(baseDir, { links: false });
    await assert.rejects(store.prepare('SELECT * FROM links'), /no such table/);
  });

  it('toggling a feature rebuilds the cache', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'See [[b]].');
    write(baseDir, 'b.md', 'target');

    const first = await openTree(baseDir, { links: false });
    await first.store.close();

    const second = await openTree(baseDir);
    assert.equal(second.parsed, 2, 'feature toggle should force a full re-crawl');
    const rows = (await (await second.store.prepare('SELECT COUNT(*) AS n FROM links')).get()) as { n: number };
    assert.equal(rows.n, 1);
    await second.store.close();
  });

  it('incremental resolve: deleting the lexicographically-first of two same-basename files re-points existing links to the survivor', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a/dup.md', 'target A');
    write(baseDir, 'b/dup.md', 'target B');
    write(baseDir, 'src.md', 'See [[dup]].');
    for (let i = 0; i < 7; i++) write(baseDir, `filler${i}.md`, 'filler');

    const first = await openTree(baseDir);
    const before = (await (await first.store.prepare('SELECT dst FROM links WHERE src = ?')).get('src.md')) as { dst: string };
    assert.equal(before.dst, 'a/dup.md', 'lexicographically-first wins the tie');
    await first.store.close();

    // one file removed out of ten stays well under the incremental/full-fallback ratio
    rmSync(join(baseDir, 'a/dup.md'));
    const second = await openTree(baseDir);
    const after = (await (await second.store.prepare('SELECT dst FROM links WHERE src = ?')).get('src.md')) as { dst: string };
    assert.equal(after.dst, 'b/dup.md', 'removing the tie-winner should re-point to the survivor');
    await second.store.close();
  });

  it('incremental resolve matches a full rebuild byte-for-byte after add/delete/modify', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the hub');
    write(baseDir, 'a.md', 'See [[hub]] and [[missing]].');
    write(baseDir, 'sub/b.md', '[relative](../hub.md)');
    for (let i = 0; i < 13; i++) write(baseDir, `filler${i}.md`, `mentions [[filler${(i + 1) % 13}]]`);

    const first = await openTree(baseDir);
    await first.store.close();

    // add + delete + modify in one reconcile, still under the 20% churn threshold (3 of 16 files)
    write(baseDir, 'new.md', 'points at [[a]]');
    rmSync(join(baseDir, 'filler12.md'));
    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', 'See [[hub]] and [[missing]], now also [[sub/b]].');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const incremental = await openTree(baseDir);
    const incrementalRows = await (await incremental.store.prepare('SELECT src, target, dst FROM links ORDER BY src, target')).all();
    await incremental.store.close();

    const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null };
    clearCache(cfg);
    const rebuilt = await open(cfg);
    const rebuiltRows = await (await rebuilt.store.prepare('SELECT src, target, dst FROM links ORDER BY src, target')).all();
    await rebuilt.store.close();

    assert.deepEqual(incrementalRows, rebuiltRows);
  });
});
