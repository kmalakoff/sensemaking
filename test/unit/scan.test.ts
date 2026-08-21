import assert from 'node:assert';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { toPosixPath } from '../../src/scan.ts';
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
      presets: { default: { include: ['**/*.md'] }, wiki: { include: ['wiki/**/*.md'] }, raw: { include: ['raw/**/*.md'] } },
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
      presets: { default: { include: ['**/*.md'] }, alpha: { include: ['shared/**/*.md'] }, beta: { include: ['shared/**/*.md'] } },
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
      presets: { default: { include: ['**/*.md'] }, empty: { include: ['nonexistent/**/*.md'] } },
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
      presets: { default: { include: ['wiki/**/*.md'] } },
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
        default: { include: ['applications/**/*.md'], exclude: ['**/application.md'] },
        application: { include: ['applications/**/application.md'] },
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

  // node:fs glob replaced fast-glob (0.9.6). It matches directories and dangling symlinks,
  // and does not walk symlinked directories, none of which was true of fast-glob.
  it('a directory whose name matches the glob is not indexed', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'real.md', { frontmatter: { title: 'Real' } });
    mkdirSync(join(baseDir, 'notes.md'));

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'] } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['real.md']
    );
  });

  it('a dangling symlink is skipped rather than throwing', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'real.md', { frontmatter: { title: 'Real' } });
    symlinkSync('gone.md', join(baseDir, 'broken.md'));

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'] } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['real.md']
    );
  });

  it('a symlinked directory is not indexed a second time under the link path', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'notes/a.md', { frontmatter: { title: 'A' } });
    symlinkSync(join(baseDir, 'notes'), join(baseDir, 'mirror'));

    const { db } = openConfig({
      presets: { default: { include: ['**/*.md'] } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const rows = db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['notes/a.md']
    );
  });

  it('brace expansion and extglob patterns still resolve in a preset include', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.markdown', { frontmatter: { title: 'B' } });
    writeNote(baseDir, 'c.txt', { frontmatter: { title: 'C' } });

    const { db } = openConfig({
      presets: { default: { include: ['**/*.{md,markdown}'] }, ext: { include: ['**/@(a|c).*'] } },
      queries: {},
      baseDir,
      configPath: null,
    });

    const coverage = db.prepare('SELECT preset, path FROM preset_files ORDER BY preset, path').all() as Array<{ preset: string; path: string }>;
    assert.deepEqual(coverage, [
      { preset: 'default', path: 'a.md' },
      { preset: 'default', path: 'b.markdown' },
      { preset: 'ext', path: 'a.md' },
      { preset: 'ext', path: 'c.txt' },
    ]);
  });
});

// Everything downstream assumes POSIX paths: node:path/posix link resolution, `wiki/**` scope
// matching, `path LIKE 'raw/%'`. Passing the separator tests the Windows branch anywhere.
describe('stored paths are POSIX on every platform', () => {
  it('a Windows separator is normalized', () => {
    assert.equal(toPosixPath('notes\\sub\\a.md', '\\'), 'notes/sub/a.md');
    assert.equal(toPosixPath('a.md', '\\'), 'a.md');
  });

  it('a POSIX platform leaves the path alone, since a backslash is a legal filename character', () => {
    assert.equal(toPosixPath('weird\\name.md', '/'), 'weird\\name.md');
    assert.equal(toPosixPath('notes/a.md', '/'), 'notes/a.md');
  });
});
