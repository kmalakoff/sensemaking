import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// v3 turns semantic on by default; these tests never need vectors and must never touch the
// network, so every fixture config below pins the default preset's semantic off.
function writeConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, ...config }));
}

const DEFAULT_LEXICAL = { default: { include: ['*.md'] } };

function makeTree(): string {
  const dir = tmpTree();
  writeNote(dir, 'floor.md', { frontmatter: { title: 'Pricing floor', status: 'active' }, body: 'The price floor is 100 credits. See [[context]] for why.' });
  writeNote(dir, 'context.md', { frontmatter: { title: 'Context', status: 'active' }, body: 'Background that never mentions the c-word or the s-word.' });
  writeNote(dir, 'archived.md', { frontmatter: { title: 'Old', status: 'archived' }, body: 'Old price discussion, superseded.' });
  writeNote(dir, 'unrelated.md', { frontmatter: { title: 'Gardening', status: 'active' }, body: 'Gardening notes.' });
  return dir;
}

function twoPresetTree(): string {
  const dir = tmpTree();
  writeNote(dir, 'wiki/page.md', { frontmatter: { title: 'Wiki page' }, body: 'alpha subject in the wiki' });
  writeNote(dir, 'raw/source.md', { frontmatter: { title: 'Raw source' }, body: 'alpha subject in raw' });
  return dir;
}
const TWO_PRESETS = { default: { include: ['**/*.md'] }, wiki: { include: ['wiki/**/*.md'] }, raw: { include: ['raw/**/*.md'] } };

describe('saved searches', () => {
  it('sense <name> --format json matches sense search --format json shape, and respects saved k', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', k: 2 } } });

    const saved = runCli(['hot', '--format', 'json'], { cwd: dir });
    assert.equal(saved.status, 0, saved.stderr);
    const savedRows = JSON.parse(saved.stdout);

    const direct = runCli(['search', 'price', '--k', '2', '--format', 'json'], { cwd: dir });
    assert.equal(direct.status, 0, direct.stderr);
    const directRows = JSON.parse(direct.stdout);

    assert.deepEqual(savedRows, directRows);
    assert.ok(savedRows.length <= 2, `expected saved k=2 to cap rows, got ${savedRows.length}`);
  });

  it('--where on the invocation overrides the saved where', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', where: "f.status = 'archived'" } } });

    const scoped = runCli(['hot', '--format', 'json'], { cwd: dir });
    assert.equal(scoped.status, 0, scoped.stderr);
    const scopedRows = JSON.parse(scoped.stdout) as Array<{ path: string }>;
    assert.ok(
      scopedRows.every((r) => r.path === 'archived.md'),
      `saved where should scope to archived.md: ${JSON.stringify(scopedRows)}`
    );

    const overridden = runCli(['hot', '--where', "f.status = 'active'", '--format', 'json'], { cwd: dir });
    assert.equal(overridden.status, 0, overridden.stderr);
    const overriddenRows = JSON.parse(overridden.stdout) as Array<{ path: string }>;
    assert.ok(overriddenRows.some((r) => r.path === 'floor.md'));
    assert.ok(overriddenRows.every((r) => r.path !== 'archived.md'));
  });

  it('--preset on the invocation overrides the saved preset', () => {
    const dir = twoPresetTree();
    writeConfig(dir, { presets: TWO_PRESETS, queries: { hot: { search: 'alpha', preset: 'wiki' } } });

    const scoped = runCli(['hot', '--format', 'json'], { cwd: dir });
    assert.equal(scoped.status, 0, scoped.stderr);
    assert.deepEqual(
      (JSON.parse(scoped.stdout) as Array<{ path: string }>).map((r) => r.path),
      ['wiki/page.md']
    );

    const overridden = runCli(['hot', '--preset', 'raw', '--format', 'json'], { cwd: dir });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.deepEqual(
      (JSON.parse(overridden.stdout) as Array<{ path: string }>).map((r) => r.path),
      ['raw/source.md']
    );
  });

  it('--lexical is gone from saved searches too: it exits 2 rather than being silently ignored', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price' } } });

    const plain = runCli(['hot', '--format', 'json'], { cwd: dir });
    const lexical = runCli(['hot', '--lexical', '--format', 'json'], { cwd: dir });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(lexical.status, 2, lexical.stderr);
  });

  it('a saved search still carrying "semantic" is a named config error, not silently ignored', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', semantic: true } } });

    const result = runCli(['hot'], { cwd: dir });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /unknown key\(s\) semantic/);
  });

  it('a positional parameter on a saved search exits 2', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price' } } });

    const result = runCli(['hot', 'extra'], { cwd: dir });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no positional parameters/);
  });

  it('a queries entry that is neither { sql } nor { search } is a named config error, not a TypeError', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { k: 5 } } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.hot must be \{ sql \} or \{ search/);
    assert.ok(!result.stderr.includes('TypeError'), result.stderr);
  });

  it('a saved search with an unknown key is a named config error', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', bogus: true } } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.hot has unknown key\(s\) bogus/);
  });

  it('a saved search with a non-positive-integer k is a named config error', () => {
    const dir = makeTree();
    for (const k of [0, -1, 1.5]) {
      writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', k } } });
      const result = runCli(['--list'], { cwd: dir });
      assert.equal(result.status, 1, `k=${k} should be rejected`);
      assert.match(result.stderr, /queries\.hot\.k must be a positive integer/);
    }
  });

  it('check fails on a saved search naming an unknown preset', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', preset: 'nope' } } });

    const result = runCli(['check'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /hot.*FAILED/);
    assert.match(result.stdout, /unknown preset "nope"/);
  });

  it('--list labels both kinds, so the verb an entry runs is visible without opening the config', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price' }, plain: { sql: 'SELECT path FROM frontmatter' } } });

    const listed = runCli(['--list'], { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /hot\s+\(search\)/);
    assert.match(listed.stdout, /plain\s+\(sql\)/);
  });

  it('--list labels an explicit { sql } entry as sql, never as a search', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { wrapped: { sql: 'SELECT path FROM frontmatter' } } });

    const listed = runCli(['--list'], { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /wrapped\s+\(sql\)/);
  });

  it('--k rejects zero, negatives, and fractions on saved searches and on search itself', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price' } } });
    for (const bad of ['0', '-1', '5.9']) {
      assert.equal(runCli(['hot', '--k', bad], { cwd: dir }).status, 2, `saved search --k ${bad}`);
      assert.equal(runCli(['search', 'price', '--k', bad], { cwd: dir }).status, 2, `search --k ${bad}`);
    }
  });

  it('check probes a saved search lexically: a typo in where fails check, not the eventual caller', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { hot: { search: 'price', where: "f.stauts = 'active'" } } });

    const result = runCli(['check'], { cwd: dir });
    assert.equal(result.status, 1, `expected check to fail: ${result.stdout}`);
    assert.match(result.stdout, /hot.*FAILED/);
    assert.match(result.stdout, /stauts/);
  });

  it('a { sql } entry lists as sql', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { plain: { sql: 'SELECT path FROM frontmatter' } } });

    const listed = runCli(['--list'], { cwd: dir });
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout.trim(), 'plain  (sql)');
  });
});

// v4 entries name their verb, one to one with the two commands. A bare string used to mean
// SQL by inference; the error hands back the corrected entry rather than describing it.
describe('queries entries name their verb', () => {
  it('a bare string is rejected with the { sql } form it should have been', () => {
    const dir = makeTree();
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { oops: 'SELECT path FROM frontmatter' } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /queries\.oops must say which verb it runs/);
    assert.match(result.stderr, /\{ "sql": "SELECT path FROM frontmatter" \}/);
  });

  it('a long bare string is elided in the suggestion rather than echoed whole', () => {
    const dir = makeTree();
    const long = `SELECT path FROM frontmatter WHERE ${'x'.repeat(80)} = 1`;
    writeConfig(dir, { presets: DEFAULT_LEXICAL, queries: { oops: long } });

    const result = runCli(['--list'], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.\.\./);
    assert.ok(!result.stderr.includes(long), result.stderr);
  });
});
