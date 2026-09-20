import { EventEmitter, once } from 'node:events';
import assert from 'assert';
import { serialQuery } from '../../../src/lib/serial-query.ts';

describe('serialQuery', () => {
  it('orders one handle, allows independent handles, and releases the queue after failure', async () => {
    const handle = {};
    const events: string[] = [];
    const barrier = new EventEmitter();
    const gate = once(barrier, 'release');
    const error = new Error('authored query failure');
    const first = serialQuery(handle, async () => {
      events.push('first');
      await gate;
      throw error;
    });
    const rejected = assert.rejects(first, (err) => err === error);
    const second = serialQuery(handle, async () => {
      events.push('second');
      return 42;
    });
    try {
      await serialQuery({}, async () => {
        events.push('independent');
      });
      assert.deepEqual(events, ['first', 'independent']);
    } finally {
      barrier.emit('release');
      await Promise.allSettled([first, second]);
    }
    await rejected;
    assert.equal(await second, 42);
    assert.deepEqual(events, ['first', 'independent', 'second']);
  });
});
