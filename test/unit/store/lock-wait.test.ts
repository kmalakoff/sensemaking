import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { STATE_DIR } from '../../../src/config/index.ts';
import { lockWaitBudgetMs, recordLockWaitMs } from '../../../src/store/lock-wait.ts';
import { scratchDir } from '../../lib/scratch.ts';

function fixture(): { configDir: string; sidecar: string } {
  const configDir = scratchDir('lock-wait');
  const stateDir = join(configDir, STATE_DIR);
  mkdirSync(stateDir);
  return { configDir, sidecar: join(stateDir, 'lock-wait.json') };
}

function readSidecar(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('lock-wait sidecar', () => {
  it('records a real zero duration when no prior sidecar exists', () => {
    const { configDir, sidecar } = fixture();
    assert.equal(existsSync(sidecar), false);

    recordLockWaitMs(configDir, 0);

    assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 0 });
    assert.equal(lockWaitBudgetMs(configDir), 5_000);
  });

  it('treats malformed, nonfinite, and negative saved durations as absent', () => {
    for (const saved of ['not json', '{"reconcile_max_ms":1e400}', '{"reconcile_max_ms":-1}']) {
      const { configDir, sidecar } = fixture();
      writeFileSync(sidecar, saved);

      assert.equal(lockWaitBudgetMs(configDir), 5_000);
      recordLockWaitMs(configDir, 0);
      assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 0 });
    }
  });

  it('retains the largest duration and derives the floored, tripled, and capped budgets', () => {
    const { configDir, sidecar } = fixture();

    recordLockWaitMs(configDir, 1_000);
    assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 1_000 });
    assert.equal(lockWaitBudgetMs(configDir), 5_000);

    recordLockWaitMs(configDir, 500);
    assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 1_000 });

    recordLockWaitMs(configDir, 2_000);
    assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 2_000 });
    assert.equal(lockWaitBudgetMs(configDir), 6_000);

    recordLockWaitMs(configDir, 300_000);
    assert.deepEqual(readSidecar(sidecar), { reconcile_max_ms: 300_000 });
    assert.equal(lockWaitBudgetMs(configDir), 600_000);
  });
});
