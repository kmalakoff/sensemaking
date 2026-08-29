import assert from 'assert';
import { guardedTick } from '../../../src/lib/guarded-tick.ts';

// Awaiting a couple of microtask turns gives a rejection produced by fn() time to surface
// as unhandledRejection if the guard failed to attach a handler in the same tick.
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('guardedTick', () => {
  it('a rejecting fn produces no unhandled rejection', async () => {
    const caught: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => caught.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const tick = guardedTick(
        () => Promise.reject(new Error('boom')),
        () => false
      );
      tick();
      await flush();
      assert.deepEqual(caught, []);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('skip() true never invokes fn', async () => {
    let calls = 0;
    const tick = guardedTick(
      async () => {
        calls++;
      },
      () => true
    );
    tick();
    tick();
    await flush();
    assert.equal(calls, 0);
  });

  it('skip() false invokes fn each call', async () => {
    let calls = 0;
    const tick = guardedTick(
      async () => {
        calls++;
      },
      () => false
    );
    tick();
    tick();
    tick();
    await flush();
    assert.equal(calls, 3);
  });

  it('a rejecting fn does not prevent later successful invocations', async () => {
    let calls = 0;
    let reject = true;
    const tick = guardedTick(
      async () => {
        calls++;
        if (reject) {
          reject = false;
          throw new Error('boom');
        }
      },
      () => false
    );
    tick();
    await flush();
    tick();
    await flush();
    assert.equal(calls, 2);
  });
});
