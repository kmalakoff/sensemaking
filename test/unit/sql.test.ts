import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
