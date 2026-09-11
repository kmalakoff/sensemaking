import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { WATCH_CLAIM_FILENAME, WatchClaimDatabase } from '../../../src/watch-claim.ts';
import { runCli } from '../../lib/cli.ts';
import { scratchDir } from '../../lib/scratch.ts';

// status opens every store the config names. busy_timeout comes from Store.engineStatus(),
// which each store owns; duckdb reports an empty record instead of a dialect-only pragma error.
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
    assert.equal(existsSync(join(dir, WATCH_CLAIM_FILENAME)), false, 'reading status must not create watcher coordination state');
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

  it('reports the config-owned watcher claim', async () => {
    const dir = makeTree();
    const claim = new WatchClaimDatabase(dir);
    try {
      await claim.acquire('status-owner', 4242, false);
      const result = runCli(['status', '--format', 'json', '--config', join(dir, 'sense.config.json')]);
      assert.equal(result.status, 0, result.stderr);
      const out = JSON.parse(result.stdout) as { watcherPid: string | null; watcherHeartbeatSecondsAgo: number | null };
      assert.equal(out.watcherPid, '4242');
      assert.ok(out.watcherHeartbeatSecondsAgo !== null && out.watcherHeartbeatSecondsAgo >= 0 && out.watcherHeartbeatSecondsAgo <= 5);
    } finally {
      claim.release('status-owner');
      claim.close();
    }
  });
});
