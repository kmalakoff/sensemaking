import assert from 'assert';
import { STATE_DIR } from '../../../src/config/types.ts';
import { shouldReconcileWatchNotification } from '../../../src/lib/watch-notification.ts';
import { WATCH_CLAIM_FILENAME } from '../../../src/watch-claim.ts';

describe('shouldReconcileWatchNotification', () => {
  it('ignores root state paths', () => {
    for (const filename of [STATE_DIR, `${STATE_DIR}/cache.db`, `${STATE_DIR}/cache.db-wal`, `${STATE_DIR}\\cache.db`, `${STATE_DIR}\\cache.db-wal`, WATCH_CLAIM_FILENAME, `${WATCH_CLAIM_FILENAME}-wal`]) {
      assert.equal(shouldReconcileWatchNotification(filename), false, filename);
    }
  });

  it('reconciles normal paths', () => {
    for (const filename of ['Note.md', 'folder/Note.md', 'folder\\Note.md']) {
      assert.equal(shouldReconcileWatchNotification(filename), true, filename);
    }
  });

  it('reconciles when the native notification has no usable filename', () => {
    assert.equal(shouldReconcileWatchNotification(null), true);
    assert.equal(shouldReconcileWatchNotification(Buffer.from('.sense/cache.db')), true);
  });
});
