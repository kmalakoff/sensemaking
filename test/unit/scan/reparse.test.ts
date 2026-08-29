import assert from 'node:assert';
import type { Config } from 'sensemaking';
import type { Feature } from '../../../src/features/types.ts';
import { listFiles } from '../../../src/scan/index.ts';
import { reparseFiles } from '../../../src/scan/reparse.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

const cfg: Config = { presets: { default: { include: ['**/*.md'] } }, queries: {} };

function noopFeature(name: Feature['name'], overrides: Partial<Feature> = {}): Feature {
  return { name, async schema() {}, ...overrides };
}

describe('reparseFiles', () => {
  it('collects new frontmatter columns in first-seen order across files, skipping already-known ones', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { zeta: 1, alpha: 2 } });
    writeNote(baseDir, 'b.md', { frontmatter: { alpha: 3, beta: 4 } });
    writeNote(baseDir, 'c.md', { frontmatter: { gamma: 5, zeta: 6 } });
    const files = listFiles(cfg, baseDir);

    const result = reparseFiles(files, [], cfg, new Set(['alpha']));

    assert.deepEqual(result.newColumns, ['zeta', 'beta', 'gamma']);
    assert.deepEqual(
      result.docs.map((d) => d.relPath),
      ['a.md', 'b.md', 'c.md']
    );
  });

  it('does not mutate the knownColumns set passed in', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { fresh: 1 } });
    const files = listFiles(cfg, baseDir);
    const known = new Set(['other']);

    reparseFiles(files, [], cfg, known);

    assert.deepEqual([...known], ['other']);
  });

  it('applies enabledForFile per file: a feature opted out for one file leaves no extracted entry for it', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'special/x.md', { frontmatter: { title: 'X' } });
    writeNote(baseDir, 'normal/y.md', { frontmatter: { title: 'Y' } });
    const files = listFiles(cfg, baseDir);

    const always = noopFeature('links', { extract: () => 'always' });
    const specialOnly = noopFeature('tags', {
      extract: () => 'special',
      enabledForFile: (_cfg, file) => file.relPath.startsWith('special/'),
    });

    const result = reparseFiles(files, [always, specialOnly], cfg, new Set());
    const byPath = new Map(result.docs.map((d) => [d.relPath, d]));

    assert.equal(byPath.get('special/x.md')?.extracted.links, 'always');
    assert.equal(byPath.get('special/x.md')?.extracted.tags, 'special');
    assert.equal(byPath.get('normal/y.md')?.extracted.links, 'always');
    assert.ok(!('tags' in (byPath.get('normal/y.md')?.extracted ?? {})), 'opted-out feature leaves no extracted entry');
  });

  it('accumulates warnings in file order, including files that contribute none', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'created: 2024-13-40T99:99' }); // invalid date
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'clean' } }); // no warning
    writeNote(baseDir, 'c.md', { frontmatter: { path: 'reserved-collision' } }); // reserved key
    const files = listFiles(cfg, baseDir);

    const result = reparseFiles(files, [], cfg, new Set());

    assert.deepEqual(result.warnings, ['warning: a.md: created is not a valid date (2024-13-40T99:99), so it is invisible to every date comparison', 'warning: c.md has a frontmatter key named "path", which is reserved; ignoring it']);
  });

  it('calls onParsed once per file, in order, with a running 1-based count', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    writeNote(baseDir, 'b.md');
    writeNote(baseDir, 'c.md');
    const files = listFiles(cfg, baseDir);
    const ticks: number[] = [];

    reparseFiles(files, [], cfg, new Set(), (done) => ticks.push(done));

    assert.deepEqual(ticks, [1, 2, 3]);
  });

  it('an empty file list returns empty results and never calls onParsed', () => {
    let called = false;
    const result = reparseFiles([], [], cfg, new Set(), () => {
      called = true;
    });
    assert.deepEqual(result, { docs: [], warnings: [], newColumns: [] });
    assert.equal(called, false);
  });
});
