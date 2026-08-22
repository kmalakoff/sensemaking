import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli as spawnCli } from '../lib/cli.ts';

// Every temp dir this file creates, cleaned up once after all its tests have run.
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function makeTree(): string {
  const dir = tempDir('sense-sql-');
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
// so a temp view over `content` cannot carry it.
describe('sql --preset', () => {
  function scopedTree(): string {
    const dir = tempDir('sense-scope-');
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

// A tree whose values exercise every character csv has to quote.
function makeFormatTree(): string {
  const dir = tempDir('sense-format-');
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {} }));
  writeFileSync(join(dir, 'comma.md'), '---\ntitle: Quarterly, with a comma\n---\nbody\n');
  writeFileSync(join(dir, 'quote.md'), '---\ntitle: \'He said "hi"\'\n---\nbody\n');
  writeFileSync(join(dir, 'newline.md'), '---\ntitle: Wrapped\nnote: |\n  first line\n  second line\n---\nbody\n');
  return dir;
}

describe('sql output formats', () => {
  // The rows now stream out one at a time rather than being rendered from one array, so what
  // is asserted is that the streamed bytes are the ones the array form produced.
  for (const [name, where, expected] of [
    ['no rows', "WHERE path = 'nope'", []],
    ['one row', "WHERE path = 'one.md'", [{ path: 'one.md' }]],
    ['many rows', '', [{ path: 'one.md' }, { path: 'two.md' }]],
  ] as Array<[string, string, unknown[]]>) {
    it(`--format json is byte-identical to the whole-array rendering: ${name}`, () => {
      const dir = makeTree();
      const result = runCli(dir, ['sql', `SELECT path FROM frontmatter ${where} ORDER BY path`, '--format', 'json']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${JSON.stringify(expected, null, 2)}\n`);
    });
  }

  it('--format csv quotes commas, quotes, and embedded newlines, doubling internal quotes', () => {
    const dir = makeFormatTree();
    const result = runCli(dir, ['sql', 'SELECT title FROM frontmatter WHERE title IS NOT NULL ORDER BY path', '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'title\n"Quarterly, with a comma"\nWrapped\n"He said ""hi"""\n');
  });

  it('--format csv keeps a newline a note actually contains, where the table renderer flattens it', () => {
    const dir = makeFormatTree();
    const result = runCli(dir, ['sql', 'SELECT note FROM frontmatter WHERE note IS NOT NULL', '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^note\n"first line\nsecond line/);
  });

  it('--format csv emits its header on a 0-row result, since the columns come from the statement', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', "SELECT path, title FROM frontmatter WHERE path = 'nope'", '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'path,title\n');
  });

  it('--format table is unchanged by streaming', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path FROM frontmatter ORDER BY path']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'path\n------\none.md\ntwo.md\n');
  });

  it('an unrecognised --format exits 2 instead of silently rendering a table', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path FROM frontmatter', '--format', 'nonsense']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --format "nonsense"; expected table, json, csv/);
  });

  it('csv is refused where the command renders a structure rather than a row set', () => {
    const dir = makeTree();
    const result = runCli(dir, ['map', '--format', 'csv']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown --format "csv"; expected table, json/);
  });

  it('a MATCH syntax error still reaches the caller with stdout untouched', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', "SELECT path FROM content WHERE content MATCH 'unbalanced('", '--format', 'json']);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });
  it('a duplicated output column name prints one column, never one value under two headers', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT path AS x, title AS x FROM frontmatter ORDER BY path', '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    // The statement names x twice; the row object has already collapsed them, and csv follows
    // the row rather than reprinting the survivor under both headers.
    assert.equal(result.stdout.split('\n')[0], 'x');
  });

  it('a bounded command finding nothing writes no csv at all, not a bare newline', () => {
    const dir = makeTree();
    const result = runCli(dir, ['search', 'zzzznope', '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    // A lone newline reads to a csv parser as one empty record.
    assert.equal(result.stdout, '');
  });

  it('an int64 past 2^53 arrives as a decimal string in json, since a JSON number cannot carry it losslessly', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT 9223372036854775807 AS v', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.equal(rows[0].v, '9223372036854775807');
  });

  it('an int64 past 2^53 prints verbatim in csv', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT 9223372036854775807 AS v', '--format', 'csv']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'v\n9223372036854775807\n');
  });

  it('a small integer stays a json number, not a string', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', 'SELECT 2 AS v', '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.equal(rows[0].v, 2);
    assert.equal(typeof rows[0].v, 'number');
  });

  it('an int64 past 2^53 on a later row no longer truncates the stream mid-array', () => {
    const dir = makeTree();
    const result = runCli(dir, ['sql', "SELECT path, CASE WHEN path = 'two.md' THEN 9223372036854775807 ELSE 1 END AS v FROM frontmatter ORDER BY path", '--format', 'json']);
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows, [
      { path: 'one.md', v: 1 },
      { path: 'two.md', v: '9223372036854775807' },
    ]);
  });
});
