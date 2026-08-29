import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SenseError } from '../../../../src/errors.ts';
import { loadOrInstall } from '../../../../src/store/duckdb/native.ts';
import { scratchDir } from '../../../lib/scratch.ts';

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
    chmodSync(nodeModulesPath, 0o444);
    try {
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
      chmodSync(nodeModulesPath, 0o755);
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
