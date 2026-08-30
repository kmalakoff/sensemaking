import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../lib/cli.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

// A frontmatter key with punctuation (`plugin-id`) is a real column, but unquoted in SQL it
// parses as an expression; each engine names a fragment (or a table) the user never wrote.
// These check the hint that maps it back to the actual column, on both stores.

function writeConfig(baseDir: string): void {
  writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
}

describe('column-hint', () => {
  it('sense sql: unquoted punctuated column errors with a quoting hint', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { 'plugin-id': 'x' } });
    writeConfig(baseDir);
    const result = runCli(['sql', 'SELECT path FROM frontmatter WHERE plugin-id IS NOT NULL'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /"plugin-id"/);
    assert.match(result.stderr, /double.quot/i);
  });

  it('sense sql: double-quoted form succeeds', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { 'plugin-id': 'x' } });
    writeConfig(baseDir);
    const result = runCli(['sql', 'SELECT path FROM frontmatter WHERE "plugin-id" IS NOT NULL', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(result.stdout).map((r: { path: string }) => r.path),
      ['a.md']
    );
  });

  it('a scoped command --where gets the same hint, alias prefix included', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { 'plugin-id': 'x' } });
    writeConfig(baseDir);
    const result = runCli(['map', '--where', 'f.plugin-id IS NOT NULL'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /"plugin-id"/);
    assert.match(result.stderr, /double.quot/i);
  });

  it('the duckdb store gets the same hint from its binder error text', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { 'plugin-id': 'x' } });
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const result = runCli(['sql', 'SELECT path FROM frontmatter WHERE plugin-id IS NOT NULL'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /"plugin-id"/);
    assert.match(result.stderr, /double.quot/i);
  });

  it('a genuinely unknown column errors without a false suggestion', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { 'plugin-id': 'x' } });
    writeConfig(baseDir);
    const result = runCli(['sql', 'SELECT path FROM frontmatter WHERE nosuchfield IS NOT NULL'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no such column: nosuchfield/);
    assert.doesNotMatch(result.stderr, /double.quot/i);
  });
});
