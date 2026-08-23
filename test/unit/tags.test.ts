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
