import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

describe('sections feature', () => {
  it('headings become rows with 1-indexed line ranges over the raw file and token estimates', async () => {
    const baseDir = tmpTree();
    // frontmatter occupies lines 1-3; body starts at line 4 (blank), heading on line 5
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: A\n---\n\n# First\n\nprose here\n\n## Second\n\nmore prose\n');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx')).all('a.md')) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { level: 1, heading: 'First', start_line: 5, end_line: 8, tokens: rows[0].tokens });
    assert.equal(rows[1].heading, 'Second');
    assert.equal(rows[1].start_line, 9);
    assert.ok((rows[0].tokens as number) > 0);
  });

  it('headings inside fenced code blocks are not sections', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '# Real\n\n```\n# not a heading\n```\n');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT heading FROM sections WHERE "path" = ?')).all('a.md')) as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['Real']
    );
  });

  it('a heading between a nested fence inner and outer closer is not a section; one after the outer closer is', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '````\n```\n# not a section (still inside the outer fence)\n```\n````\n\n# after the outer closer\n');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT heading FROM sections WHERE "path" = ?')).all('a.md')) as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['after the outer closer']
    );
  });

  // The outline comes from parse()'s heading blocks, so mdast's CommonMark fences decide it. An
  // indented fence is where that could diverge: a column-0 hash inside one stays code.
  it('an indented fence still opens a fence: a column-zero heading inside it is not a section', async () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '# real\n\n   ```\n# inside a 3-space indented fence\n   ```\n\n## after\n');

    const { store } = await openTree(baseDir);
    const rows = (await (await store.prepare('SELECT heading FROM sections WHERE "path" = ? ORDER BY idx')).all('a.md')) as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['real', 'after']
    );
  });
});
