import assert from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../lib/cli.ts';
import { scratchDir } from '../../lib/scratch.ts';

// status is what an agent runs first, so it has to open every store the config names.
// busy_timeout is a sqlite-engine fact (derived in sqlite's open, read back from the
// connection); a store without one reports null, not a dialect-only pragma error.
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
    const out = JSON.parse(result.stdout) as { busyTimeoutMs: number };
    assert.ok(out.busyTimeoutMs >= 30000, `busyTimeoutMs ${out.busyTimeoutMs} under the 30s floor`);
  });

  it('duckdb opens and reports busyTimeoutMs null', () => {
    const dir = makeTree('duckdb');
    const result = runCli(['status', '--format', 'json', '--config', join(dir, 'sense.config.json')]);
    assert.equal(result.status, 0, result.stderr);
    const out = JSON.parse(result.stdout) as { busyTimeoutMs: number | null };
    assert.equal(out.busyTimeoutMs, null);
  });

  it('duckdb text output drops the sqlite line', () => {
    const dir = makeTree('duckdb');
    const result = runCli(['status', '--config', join(dir, 'sense.config.json')]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /busy_timeout/);
  });
});
