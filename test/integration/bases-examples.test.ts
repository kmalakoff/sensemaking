import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// The two worked translations in skills/sense-bases/EXAMPLES.md, run against a fixture so the
// skill's SQL cannot rot away from the schema it documents.

function writeConfig(baseDir: string): void {
  writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
}

describe('sense-bases worked examples', () => {
  it('A: filtered, sorted view over link-list frontmatter and basename()', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'Heat.md', { frontmatter: { categories: ['[[Movies]]'], year: 1995, scoreImdb: 8.3 } });
    writeNote(baseDir, 'Ronin.md', { frontmatter: { categories: ['[[Movies]]'], year: 1998, scoreImdb: 7.2 } });
    writeNote(baseDir, 'Seen.md', { frontmatter: { categories: ['[[Movies]]'], year: 2001, scoreImdb: 9, rating: 8, last: '2024-01-01' } });
    writeNote(baseDir, 'Movie Template.md', { frontmatter: { categories: ['[[Movies]]'] } });
    // rating written as an explicit empty list: stored '[]', isEmpty() true.
    writeNote(baseDir, 'Alien.md', { frontmatter: { categories: ['[[Movies]]'], year: 1979, scoreImdb: 8.5, rating: [] } });
    writeNote(baseDir, 'Book.md', { frontmatter: { categories: ['[[Books]]'] } });
    writeConfig(baseDir);
    const sql = `SELECT basename(f.path, '.md') AS name, f.year FROM frontmatter f
      WHERE EXISTS (SELECT 1 FROM json_each(f.categories) WHERE value = '[[Movies]]')
        AND instr(basename(f.path), 'Template') = 0
        AND (f.last IS NULL OR f.last IN ('', '[]', '[null]')) AND (f.rating IS NULL OR f.rating IN ('', '[]', '[null]'))
      ORDER BY f.scoreImdb DESC, name ASC`;
    const result = runCli(['sql', sql, '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      (JSON.parse(result.stdout) as Array<{ name: string }>).map((r) => r.name),
      ['Alien', 'Heat', 'Ronin'],
      'template and rated notes excluded, sorted by score'
    );
  });

  it('B: the this-relative Related pattern with one bound path', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'Links [[x]] [[y]] [[z]] [[w]]' });
    writeNote(baseDir, 'b.md', { body: 'Shares [[x]] [[y]] [[z]]' });
    writeNote(baseDir, 'c.md', { body: 'Only [[x]]' });
    for (const n of ['x', 'y', 'z', 'w']) writeNote(baseDir, `${n}.md`, { body: 'leaf' });
    writeConfig(baseDir);
    const sql = `WITH me AS (SELECT ? AS p),
      mine AS (SELECT DISTINCT dst FROM links, me WHERE src = me.p AND dst IS NOT NULL),
      scored AS (
        SELECT f.path,
          (SELECT COUNT(DISTINCT l.dst) FROM links l WHERE l.src = f.path AND l.dst IN (SELECT dst FROM mine)) AS overlap,
          EXISTS (SELECT 1 FROM links, me WHERE src = f.path AND dst = me.p) AS links_to_me,
          EXISTS (SELECT 1 FROM links, me WHERE src = me.p AND dst = f.path) AS linked_by_me,
          (SELECT GROUP_CONCAT(DISTINCT l.dst) FROM links l WHERE l.src = f.path AND l.dst IN (SELECT dst FROM mine)) AS shared_links
        FROM frontmatter f, me WHERE f.path != me.p)
      SELECT path, overlap, shared_links FROM scored
      WHERE overlap > 2 OR links_to_me OR linked_by_me
      ORDER BY overlap DESC LIMIT 20`;
    const result = runCli(['sql', sql, 'a.md', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout) as Array<{ path: string; overlap: number; shared_links: string | null }>;
    assert.equal(rows[0].path, 'b.md');
    assert.equal(rows[0].overlap, 3);
    assert.deepEqual(rows[0].shared_links?.split(',').sort(), ['x.md', 'y.md', 'z.md']);
    const paths = rows.map((r) => r.path);
    assert.ok(!paths.includes('c.md'), 'overlap 1 with no direct link stays out');
    assert.ok(
      ['x.md', 'y.md', 'z.md', 'w.md'].every((p) => paths.includes(p)),
      'targets the note links to qualify at zero overlap'
    );
  });
});
