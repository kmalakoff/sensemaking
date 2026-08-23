import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

// extract() policy: what counts as a tag, from frontmatter or the prose, and what does not.
// Every case runs through a real index build and checks the tags table, not extract() directly.

function tagsOf(db: ReturnType<typeof openTree>['db'], path: string): string[] {
  return (db.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag').all(path) as Array<{ tag: string }>).map((r) => r.tag);
}

const CASES: Array<{ name: string; frontmatter?: Record<string, unknown> | string; body?: string; expect: string[] }> = [
  {
    name: 'frontmatter list and an inline tag merge and dedup',
    frontmatter: { tags: ['alpha', 'beta'] },
    body: 'seen here #alpha and #gamma',
    expect: ['alpha', 'beta', 'gamma'],
  },
  { name: 'frontmatter accepts a bare string too', frontmatter: { tags: 'solo' }, expect: ['solo'] },
  { name: 'a leading # on a frontmatter entry is stripped', frontmatter: { tags: ['#alpha', 'beta'] }, expect: ['alpha', 'beta'] },
  { name: 'a nested tag stores full', body: 'shelved under #book/scifi', expect: ['book/scifi'] },
  { name: 'a pure-digit tag is rejected, digits plus letters is accepted', body: 'see #5 and #2024-notes', expect: ['2024-notes'] },
  { name: 'a fenced code block is not scanned', body: 'prose #real\n\n```\n#fenced\n```\n', expect: ['real'] },
  { name: 'an inline code span is not scanned', body: 'prose #real and `#coded` stays code', expect: ['real'] },
  { name: 'mid-word # and a URL fragment are not tags', body: 'a#b and see https://x.com/page#frag', expect: [] },
  { name: 'a unicode tag is extracted', body: 'topic #日本語 today', expect: ['日本語'] },
  { name: '`tags:` over a bare `-` (a null list entry) produces no rows and does not throw', frontmatter: 'tags:\n  -', expect: [] },
  { name: 'a same-note heading link is not a tag', body: 'see [[#Heading One]] for more', expect: [] },
  { name: 'a piped heading link is not a tag', body: 'see [[#Divide up things|see below]]', expect: [] },
  { name: 'a cross-note heading link is not a tag', body: 'see [[Other Note#Some Section]]', expect: [] },
  { name: 'a hex color in an HTML style attribute is not a tag', body: '<span style="color: #ccc">x</span>', expect: [] },
  { name: 'a hex color in an HTML table cell is not a tag', body: '<td style="background: #f0f0f0">', expect: [] },
  { name: 'masking a wikilink or HTML span does not eat a real tag later on the line', body: 'see [[#Anchor]] about #real-tag', expect: ['real-tag'] },
  { name: 'a tag inside a %% comment %% is still indexed', body: '%% #placeholder/author %%', expect: ['placeholder/author'] },
  { name: 'comparison text is not an HTML span, so its tag survives', body: 'score: 3 < 5 #important because x > 2', expect: ['important'] },
  { name: 'a heading link holding a lone ] still masks whole', body: 'see [[#Steps [WIP] more]] here', expect: [] },
  {
    name: 'a 4-backtick fence wrapping a ```dataview block does not leak: the inner 3-backtick opener does not close the outer fence',
    body: '````\n```dataview\nTABLE #inner\n```\n#stillfenced\n````',
    expect: [],
  },
  { name: 'a code span opened with 2 backticks is not closed by a single backtick inside it', body: '``a `b` #inlinetag``', expect: [] },
  {
    name: 'a tilde fence wrapping a backtick fence does not leak',
    body: '~~~\n```\n#insidefence\n```\n#alsofenced\n~~~',
    expect: [],
  },
  {
    name: 'tags after a properly closed nested fence still extract',
    body: '````\n```dataview\nTABLE #inner\n```\n````\n\nprose #real',
    expect: ['real'],
  },
  { name: 'a code span masks only itself, not a tag beside it', body: '`a` #tag `b`', expect: ['tag'] },
  { name: 'a <td> block-level element on its own line opens an HTML block, so its content is not scanned', body: '<td>content #x</td>', expect: [] },
  { name: 'a <div> HTML block is not scanned on the lines before it closes', body: '<div>\ncontent\n#x\n</div>', expect: [] },
  { name: 'inline <b> does not open an HTML block, so its tag still extracts', body: '<b>#x</b>', expect: ['x'] },
  { name: 'inline <span> does not open an HTML block, so its tag still extracts', body: 'inline <span>#x</span>', expect: ['x'] },
  { name: 'a markdown link destination anchor is not a tag', body: '[text](#anchor)', expect: [] },
  {
    name: 'a <table> HTML block with <td> rows is unscanned until the blank line that closes it',
    body: '<table>\n<td>--var: #ddd</td>\n<td>--var: #eee</td>\n</table>\n\n#after',
    expect: ['after'],
  },
  {
    name: 'a <script> HTML block closes on its matching end tag, not a blank line',
    body: '<script>\nconst x = 1; // #not-a-tag\n</script>\n#real',
    expect: ['real'],
  },
  { name: 'a link and a tag on the same line: only the tag extracts', body: 'see [docs](#install) and #real-tag', expect: ['real-tag'] },
  { name: 'a link destination holding parens masks whole', body: 'see [x](https://a.com/Chromium_(web_browser)#/Browsers_based_on_Chromium) and #real', expect: ['real'] },
  { name: 'an indented HTML block in a list still swallows its content', body: '- item\n  <div>\n  body #in-list-div\n  </div>', expect: [] },
  { name: 'a blockquoted HTML block swallows its content', body: '> <div>\n> quoted #in-quote-div\n> </div>', expect: [] },
  { name: 'any type-1 closer ends a script block', body: '<script>\ncode\n</pre>\n#tag1\n</script>\n#tag2', expect: ['tag1', 'tag2'] },
  { name: 'blockquoted prose keeps its tag', body: '> quoted #in-quote-prose', expect: ['in-quote-prose'] },
];

describe('tags extraction policy', () => {
  for (const { name, frontmatter, body, expect: want } of CASES) {
    it(name, () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: frontmatter ?? {}, body: body ?? 'body' });
      const { db } = openTree(baseDir);
      assert.deepEqual(tagsOf(db, 'a.md'), want);
      db.close();
    });
  }
});

describe('tags structure', () => {
  it('a nested tag is findable through the parent-prefix EXISTS pattern', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'shelved under #book/scifi' });
    const { db } = openTree(baseDir);
    const hit = db.prepare(`SELECT "path" FROM tags WHERE tag = 'book' OR tag LIKE 'book/%'`).all() as Array<{ path: string }>;
    assert.deepEqual(
      hit.map((r) => r.path),
      ['a.md']
    );
    db.close();
  });

  it('editing a file to remove a tag removes its row on the next open', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'about #alpha and #beta' });
    const first = openTree(baseDir);
    assert.deepEqual(tagsOf(first.db, 'a.md'), ['alpha', 'beta']);
    first.db.close();

    writeNote(baseDir, 'a.md', { body: 'about #alpha only now' });
    const second = openTree(baseDir);
    assert.deepEqual(tagsOf(second.db, 'a.md'), ['alpha']);
    second.db.close();
  });

  it('a vanished file leaves no tags rows', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'about #alpha' });
    const first = openTree(baseDir);
    assert.deepEqual(tagsOf(first.db, 'a.md'), ['alpha']);
    first.db.close();

    rmSync(join(baseDir, 'a.md'));
    const second = openTree(baseDir);
    assert.deepEqual(second.db.prepare('SELECT * FROM tags').all(), []);
    second.db.close();
  });
});
