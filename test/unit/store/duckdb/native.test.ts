import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SenseError } from '../../../../src/errors.ts';
import { loadOrInstall } from '../../../../src/store/duckdb/native.ts';
import { scratchDir } from '../../../lib/scratch.ts';

// chmod is a no-op on Windows directories, so deny write with an ACL there; returns a restore fn.
function makeUnwritable(dir: string): () => void {
  if (process.platform === 'win32') {
    const deny = spawnSync('icacls', [dir, '/deny', '*S-1-1-0:(WD,AD)'], { encoding: 'utf8' });
    if (deny.status !== 0) throw new Error(`icacls /deny failed (status ${deny.status}): ${deny.error?.message ?? [deny.stdout, deny.stderr].filter(Boolean).join(' ').trim()}`);
    return () => {
      const remove = spawnSync('icacls', [dir, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' });
      if (remove.status !== 0) throw new Error(`icacls /remove:d failed (status ${remove.status}): ${remove.error?.message ?? [remove.stdout, remove.stderr].filter(Boolean).join(' ').trim()}`);
    };
  }
  chmodSync(dir, 0o444);
  return () => chmodSync(dir, 0o755);
}

// Real failures, not simulated: a genuinely nonexistent package (both the dynamic import and
// the npm install fail for real) and a genuinely unwritable target directory (the install
// caches fine but the symlink-into-place step fails for real), never a mocked installer. Both
// exercise the exact mechanics @duckdb/node-api's own path uses, over a substitute target so
// neither test downloads the real ~110MB native binding.
describe('loadOrInstall', () => {
  it('names the install failure and the manual escape hatch when the package cannot be found at all', async () => {
    const nodeModulesPath = scratchDir('duckdb-install-missing');
    const missing = `sensemaking-test-does-not-exist-${randomUUID()}`;
    await assert.rejects(
      () => loadOrInstall(missing, nodeModulesPath),
      (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'STORE_DEPENDENCY_MISSING');
        assert.match(err.message, /@duckdb\/node-api, and installing it automatically failed/);
        assert.match(err.message, /npm install @duckdb\/node-api/);
        return true;
      }
    );
  });

  it('names the install failure when the target node_modules cannot be written to', async () => {
    const parent = scratchDir('duckdb-install-readonly');
    const nodeModulesPath = join(parent, 'node_modules');
    mkdirSync(nodeModulesPath, { recursive: true });
    const restore = makeUnwritable(nodeModulesPath);
    try {
      // The denial must actually bind, or the scenario below never triggers.
      assert.throws(() => mkdirSync(join(nodeModulesPath, 'probe')));
      // A real, tiny, already-published package this project never resolves on its own (so the
      // first import genuinely fails): proves the cache/download half succeeds and the failure
      // is genuinely the read-only symlink-into-place step, same as a root-owned node_modules
      // under a global install would produce.
      await assert.rejects(
        () => loadOrInstall('is-natural-number', nodeModulesPath),
        (err: unknown) => {
          assert.ok(err instanceof SenseError);
          assert.equal(err.code, 'STORE_DEPENDENCY_MISSING');
          assert.match(err.message, /@duckdb\/node-api, and installing it automatically failed/);
          assert.match(err.message, /read-only or owned by another user/);
          assert.match(err.message, /npm install @duckdb\/node-api/);
          return true;
        }
      );
    } finally {
      restore();
    }
  });

  it('installs a real, tiny, already-published package and loads it, working around Node caching the first bare-specifier miss', async () => {
    const nodeModulesPath = scratchDir('duckdb-install-success');
    const mod = (await loadOrInstall('is-natural-number', nodeModulesPath)) as { default: (n: number) => boolean };
    assert.equal(typeof mod.default, 'function');
    assert.equal(mod.default(4), true);
    assert.equal(mod.default(-1), false);
  });
});
