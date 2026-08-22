import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli as spawnCli } from '../lib/cli.ts';

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-sql-'));
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {} }));
  writeFileSync(join(dir, 'one.md'), '---\ntitle: One\ntags: [alpha]\n---\nbody\n');
  writeFileSync(join(dir, 'two.md'), '---\ntitle: Two\ntags: [beta]\n---\nbody\n');
  return dir;
}

function runCli(dir: string, args: string[]) {
  return spawnCli([...args, '--config', join(dir, 'sense.config.json')]);
}

describe('sql subcommand (ad-hoc SQL)', () => {
  it('runs SQL directly without a saved query', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path, title FROM frontmatter ORDER BY path', '--format', 'json']);
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(
      rows.map((r: { title: string }) => r.title),
      ['One', 'Two']
    );
  });

  it('binds positional params to ? placeholders', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path FROM frontmatter WHERE has(tags, ?)', 'beta', '--format', 'json']);
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(
      rows.map((r: { path: string }) => r.path),
      ['two.md']
    );
  });

  it('wrong parameter count: exit 2', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path FROM frontmatter WHERE has(tags, ?)']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /expects 1 parameter/);
  });

  it('missing SQL: exit 2 with usage', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /sql "<statement>"/);
  });

  it('bad SQL: exit 1 with SQLite message', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT nope FROM missing_table']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such table/);
  });
});

// `sql` runs over the whole index whatever preset the other commands would have used, so
// --preset binds a `scope` table the statement joins rather than filtering behind its back.
// Applying it invisibly is not available: FTS5 MATCH uses the table name as a hidden column,
// so a temp view over `content` cannot carry it. See plans/vault-field-report-fixes.md item F.
describe('sql --preset', () => {
  function scopedTree(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sense-scope-'));
    writeFileSync(
      join(dir, 'sense.config.json'),
      JSON.stringify({
        version: 4,
        presets: { default: { include: ['notes/*.md'] }, all: { include: ['**/*.md'] } },
        queries: { hits: { sql: 'SELECT content.path FROM content JOIN scope ON scope."path" = content.path WHERE content MATCH ?' } },
      })
    );
    mkdirSync(join(dir, 'notes'), { recursive: true });
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'notes', 'a.md'), '---\ntitle: A\n---\n\nbilling tiers\n');
    writeFileSync(join(dir, 'archive', 'b.md'), '---\ntitle: B\n---\n\narchived billing\n');
    return dir;
  }

  it("binds the preset's paths as `scope`, which the statement joins", () => {
    const dir = scopedTree();
    const all = spawnCli(['sql', 'SELECT path FROM frontmatter ORDER BY path'], { cwd: dir });
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /archive\/b\.md/, 'unscoped sql is index-wide');

    const scoped = spawnCli(['sql', 'SELECT f.path FROM frontmatter f JOIN scope ON scope."path" = f.path ORDER BY f.path', '--preset', 'default'], { cwd: dir });
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /notes\/a\.md/);
    assert.doesNotMatch(scoped.stdout, /archive\/b\.md/);
  });

  it('scopes an FTS5 MATCH, which a view over the fts table could not', () => {
    const dir = scopedTree();
    const scoped = spawnCli(['hits', 'billing', '--preset', 'default'], { cwd: dir });
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.match(scoped.stdout, /notes\/a\.md/);
    assert.doesNotMatch(scoped.stdout, /archive\/b\.md/);
  });

  it('re-points a saved statement at another preset, so the name never enters the SQL', () => {
    const dir = scopedTree();
    const wide = spawnCli(['hits', 'billing', '--preset', 'all'], { cwd: dir });
    assert.equal(wide.status, 0, wide.stderr);
    assert.match(wide.stdout, /archive\/b\.md/);
    assert.match(wide.stdout, /notes\/a\.md/);
  });

  it('refuses --preset when the statement never joins scope, which would silently return everything', () => {
    const dir = scopedTree();
    const result = spawnCli(['sql', 'SELECT path FROM frontmatter', '--preset', 'default'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /never joins it/);
  });

  it('rejects an unknown preset, listing the declared ones', () => {
    const dir = scopedTree();
    const result = spawnCli(['sql', 'SELECT 1 FROM scope', '--preset', 'nope'], { cwd: dir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown preset "nope"/);
  });
});
