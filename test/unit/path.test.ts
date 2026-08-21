import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

// Same graph shape as traverse.test.ts: a -> b, a -> c, b -> d, c -> d, d -> e,
// e -> (dead link), o isolated. Shortest a..e is a, b, d, e.
function makeVault(): string {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
  writeNote(baseDir, 'b.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'c.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'd.md', { body: 'See [[e]].' });
  writeNote(baseDir, 'e.md', { body: 'Dead link: [[ghost]].' });
  writeNote(baseDir, 'o.md', { body: 'solo, no links in or out' });
  writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['**/*.md'] } }, queries: {} }, null, 2));
  return baseDir;
}

describe('sense path', () => {
  it('prints the hop chain for a path that exists', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a.md', 'e.md'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.ok(lines[0].includes('step') && lines[0].includes('path'));
    const order = ['a.md', 'b.md', 'd.md', 'e.md'];
    let cursor = 0;
    for (const p of order) {
      const idx = result.stdout.indexOf(p, cursor);
      assert.ok(idx >= 0, `expected ${p} in output: ${result.stdout}`);
      cursor = idx + p.length;
    }
  });

  it('--format json emits the ordered path as a JSON array', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a.md', 'e.md', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('no path: table says so plainly, json emits null', () => {
    const baseDir = makeVault();
    const table = runCli(['path', 'a.md', 'o.md'], { cwd: baseDir });
    assert.equal(table.status, 0, table.stderr);
    assert.match(table.stdout.trim(), /no path/i);

    const json = runCli(['path', 'a.md', 'o.md', '--format', 'json'], { cwd: baseDir });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout), null);
  });

  it('a scope excluding the only connector forces no path', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a.md', 'e.md', '--exclude', 'd.md', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), null, 'd.md is the only bridge to e.md; excluding it must remove the route');
  });

  it('--max-depth cuts off a target that is otherwise reachable', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a.md', 'e.md', '--max-depth', '2', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), null, 'a..e is 3 hops; max-depth 2 must not reach it');

    const enough = runCli(['path', 'a.md', 'e.md', '--max-depth', '3', '--format', 'json'], { cwd: baseDir });
    assert.deepEqual(JSON.parse(enough.stdout), ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('an unknown note argument errors clearly', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a.md', 'nope.md'], { cwd: baseDir });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no note matches/);
  });

  it('resolves a unique basename the same way peek does', () => {
    const baseDir = makeVault();
    const result = runCli(['path', 'a', 'e', '--format', 'json'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['a.md', 'b.md', 'd.md', 'e.md']);
  });
});
