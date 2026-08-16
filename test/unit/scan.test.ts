import assert from 'assert';
import { openConfig, tmpTree, writeNote } from '../lib/tree.ts';

// Preset coverage: a file is indexed iff any preset's include/exclude covers it (union).
// Presets overlap freely -- no disjointness error, unlike the old layer model. semantic is
// pinned off throughout via each preset -- these tests only care about file selection.

describe('presets: file coverage', () => {
  it('a two-preset tree indexes the union of both, and preset_files records each assignment', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'wiki/a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'raw/b.md', { frontmatter: { title: 'B' } });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false }, wiki: { include: ['wiki/**/*.md'], semantic: false }, raw: { include: ['raw/**/*.md'], semantic: false } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['raw/b.md', 'wiki/a.md']
    );

    const coverage = db.prepare('SELECT preset, path FROM preset_files ORDER BY preset, path').all() as Array<{ preset: string; path: string }>;
    assert.deepEqual(coverage, [
      { preset: 'default', path: 'raw/b.md' },
      { preset: 'default', path: 'wiki/a.md' },
      { preset: 'raw', path: 'raw/b.md' },
      { preset: 'wiki', path: 'wiki/a.md' },
    ]);
  });

  it('overlapping presets are not an error: a file matched by two presets is indexed once, both assignments recorded', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'shared/x.md', { frontmatter: { title: 'X' } });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false }, alpha: { include: ['shared/**/*.md'], semantic: false }, beta: { include: ['shared/**/*.md'], semantic: false } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number };
    assert.equal(rows.n, 1, 'the file is indexed once regardless of how many presets match it');

    const coverage = (db.prepare('SELECT preset FROM preset_files WHERE path = ? ORDER BY preset').all('shared/x.md') as Array<{ preset: string }>).map((r) => r.preset);
    assert.deepEqual(coverage, ['alpha', 'beta', 'default']);
  });

  it('a preset whose globs match nothing is valid, and coverage stays empty for it', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'], semantic: false }, empty: { include: ['nonexistent/**/*.md'], semantic: false } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number };
    assert.equal(rows.n, 1);
    const empty = db.prepare('SELECT COUNT(*) AS n FROM preset_files WHERE preset = ?').get('empty') as { n: number };
    assert.equal(empty.n, 0);
  });

  it('a file matched by no preset at all is absent from the index entirely', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'wiki/a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'orphan.md', { frontmatter: { title: 'Orphan' } });

    const { db } = openConfig({
      presets: { default: { include: ['wiki/**/*.md'], semantic: false } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['wiki/a.md']
    );
  });

  it('exclude narrows a preset without needing another preset to resolve an overlap', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'applications/foo/application.md', { frontmatter: { title: 'App' } });
    writeNote(baseDir, 'applications/foo/notes.md', { frontmatter: { title: 'Notes' } });

    const { db } = openConfig({
      presets: {
        default: { include: ['applications/**/*.md'], exclude: ['**/application.md'], semantic: false },
        application: { include: ['applications/**/application.md'], semantic: false },
      },
      queries: {},
      baseDir,
      configPath: null,
    });

    const coverage = db.prepare('SELECT preset, path FROM preset_files ORDER BY preset, path').all() as Array<{ preset: string; path: string }>;
    assert.deepEqual(coverage, [
      { preset: 'application', path: 'applications/foo/application.md' },
      { preset: 'default', path: 'applications/foo/notes.md' },
    ]);
  });
});
