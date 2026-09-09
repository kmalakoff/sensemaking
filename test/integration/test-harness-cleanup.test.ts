import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { cleanupScratchDirs, scratchDir } from '../lib/scratch.ts';

describe('test scratch cleanup', () => {
  it('continues owned-path cleanup after a real filesystem failure', () => {
    const blockedDir = scratchDir('cleanup-blocked');
    const laterDir = scratchDir('cleanup-later');
    const invalidPath = `${blockedDir}\0invalid`;

    assert.throws(
      () => cleanupScratchDirs([invalidPath, laterDir]),
      (err: unknown) => {
        assert.ok(err instanceof AggregateError);
        assert.equal(err.errors.length, 1);
        assert.equal(existsSync(laterDir), false);
        return true;
      }
    );
  });
});
