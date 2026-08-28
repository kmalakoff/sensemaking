import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

describe('sections feature', () => {
  it('headings become rows with 1-indexed line ranges over the raw file and token estimates', () => {
    const baseDir = tmpTree();
    // frontmatter occupies lines 1-3; body starts at line 4 (blank), heading on line 5
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: A\n---\n\n# First\n\nprose here\n\n## Second\n\nmore prose\n');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ? ORDER BY idx').all('a.md') as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { level: 1, heading: 'First', start_line: 5, end_line: 8, tokens: rows[0].tokens });
    assert.equal(rows[1].heading, 'Second');
    assert.equal(rows[1].start_line, 9);
    assert.ok((rows[0].tokens as number) > 0);
  });

  it('headings inside fenced code blocks are not sections', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '# Real\n\n```\n# not a heading\n```\n');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT heading FROM sections WHERE "path" = ?').all('a.md') as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['Real']
    );
  });

  it('a heading between a nested fence inner and outer closer is not a section; one after the outer closer is', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', '````\n```\n# not a section (still inside the outer fence)\n```\n````\n\n# after the outer closer\n');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT heading FROM sections WHERE "path" = ?').all('a.md') as Array<{ heading: string }>;
    assert.deepEqual(
      rows.map((r) => r.heading),
      ['after the outer closer']
    );
  });
});
