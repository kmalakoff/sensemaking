import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { cleanupScratchDirs, scratchDir } from '../lib/tree.ts';

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
        assert.ok(err.message.includes(invalidPath), 'the existing reporter must expose the failed owned path');
        assert.ok(err.message.includes((err.errors[0] as Error).message), 'the recorded filesystem failure must survive reporting');
        assert.equal(existsSync(laterDir), false);
        return true;
      }
    );
  });
});
