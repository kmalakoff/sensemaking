import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../lib/cli.ts';
import { scratchDir } from '../../lib/scratch.ts';

// status is what an agent runs first, so it has to open every store the config names.
// busy_timeout is reported through Store.engineStatus(), which each store owns; a store
// without a comparable setting (duckdb) reports an empty record, not a dialect-only pragma error.
function makeTree(store?: 'duckdb'): string {
  const dir = scratchDir('status');
  writeFileSync(join(dir, 'sense.config.json'), JSON.stringify({ version: 4, presets: { default: { include: ['*.md'] } }, queries: {}, ...(store ? { store } : {}) }));
  writeFileSync(join(dir, 'one.md'), '---\ntitle: One\ntags: [alpha]\n---\nbody\n');
  return dir;
}

describe('status subcommand across stores', () => {
  it('sqlite reports the derived busy_timeout', () => {
    const dir = makeTree();
    const result = runCli(['status', '--format', 'json', '--config', join(dir, 'sense.config.json')]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout) as { engine: Record<string, string> };
    const m = out.engine.busy_timeout.match(/^(\d+)ms/);
    assert.ok(m, `engine.busy_timeout ${out.engine.busy_timeout} not of the form "<n>ms ..."`);
    assert.ok(Number(m[1]) >= 30000, `busy_timeout ${m[1]}ms under the 30s floor`);
  });

  it('duckdb opens and reports an empty engine record', () => {
    const dir = makeTree('duckdb');
    const result = runCli(['status', '--format', 'json', '--config', join(dir, 'sense.config.json')]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout) as { engine: Record<string, string> };
    assert.deepEqual(out.engine, {});
  });

  it('duckdb text output drops the sqlite line', () => {
    const dir = makeTree('duckdb');
    const result = runCli(['status', '--config', join(dir, 'sense.config.json')]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /busy_timeout/);
  });
});
