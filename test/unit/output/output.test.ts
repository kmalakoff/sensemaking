import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { printRows } from '../../../src/output/output.ts';
import { configTestTree } from '../../lib/cli.ts';

// Captures printRows' one console.log call rather than mocking it: the function under test
// really runs, this only observes the side effect a spawned CLI would otherwise print.
function captureLog(fn: () => void): string {
  let out = '';
  const original = console.log;
  console.log = (msg: string) => {
    out += `${msg}\n`;
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return out;
}

const { tempDir, makeTree, runCli } = configTestTree();

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

// renderRows is shared by search, related, path and saved queries; this is the pin PLAN 3.65
// asks for before the writer changes: a single-line row must not move.
describe('table rendering: multi-line cells (search snippets)', () => {
  it('a one-element array cell renders byte-identically to the same value as a plain string', () => {
    const plain = captureLog(() => printRows([{ path: 'a.md', hit: 'first line about widgets' }], 'table'));
    const arrayed = captureLog(() => printRows([{ path: 'a.md', hit: ['first line about widgets'] }], 'table'));
    assert.equal(arrayed, plain);
  });

  it('a two-element array cell renders as two physical lines, the row as tall as its tallest cell, other columns blank-padded on the continuation line', () => {
    const out = captureLog(() => printRows([{ path: 'a.md', via: 'match', hit: ['first snippet', 'second snippet'] }], 'table'));
    const lines = out.split('\n');
    assert.equal(lines.length, 5, `expected header, separator, two body lines, trailing newline: ${JSON.stringify(out)}`);
    const [header, , body1, body2] = lines;
    assert.match(header, /^path\s+via\s+hit$/);
    assert.match(body1, /^a\.md\s+match\s+first snippet$/);
    assert.match(body2, /^\s+second snippet$/);
    assert.ok(!body2.includes('a.md') && !body2.includes('match'), `continuation line must blank-pad the other columns: ${JSON.stringify(body2)}`);
  });

  it('csv joins an array cell with a newline inside its quoted field', () => {
    const result = captureLog(() => printRows([{ path: 'a.md', hit: ['first snippet', 'second snippet'] }], 'csv'));
    assert.equal(result, 'path,hit\na.md,"first snippet\nsecond snippet"\n');
  });
});
