import assert from 'assert';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'cli.js');

function makeTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sense-query-'));
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ scan: { include: ['*.md'] }, queries: {} }));
  writeFileSync(join(dir, 'one.md'), '---\ntitle: One\ntags: [alpha]\n---\nbody\n');
  writeFileSync(join(dir, 'two.md'), '---\ntitle: Two\ntags: [beta]\n---\nbody\n');
  return dir;
}

function runCli(dir: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, '--config', join(dir, 'sense.config.json')], { encoding: 'utf8' });
}

describe('query subcommand (ad-hoc SQL)', () => {
  it('runs SQL directly without a saved query', () => {
    const dir = makeTree();
    const result = runCli(dir, ['query', 'SELECT path, title FROM docs ORDER BY path', '--format', 'json']);
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(
      rows.map((r: { title: string }) => r.title),
      ['One', 'Two']
    );
  });

  it('binds positional params to ? placeholders', () => {
    const dir = makeTree();
    const result = runCli(dir, ['query', 'SELECT path FROM docs WHERE has(tags, ?)', 'beta', '--format', 'json']);
    assert.equal(result.status, 0);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(
      rows.map((r: { path: string }) => r.path),
      ['two.md']
    );
  });

  it('wrong parameter count: exit 2', () => {
    const dir = makeTree();
    const result = runCli(dir, ['query', 'SELECT path FROM docs WHERE has(tags, ?)']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /expects 1 parameter/);
  });

  it('missing SQL: exit 2 with usage', () => {
    const dir = makeTree();
    const result = runCli(dir, ['query']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /query "<sql>"/);
  });

  it('bad SQL: exit 1 with SQLite message', () => {
    const dir = makeTree();
    const result = runCli(dir, ['query', 'SELECT nope FROM missing_table']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no such table/);
  });
});
