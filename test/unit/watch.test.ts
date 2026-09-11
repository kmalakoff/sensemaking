import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { type ResolvedConfig, STATE_DIR } from '../../src/config/index.ts';
import { SenseError } from '../../src/errors.ts';
import type { WatchEvent, WatchOptions } from '../../src/watch.ts';
import { runWatch } from '../../src/watch.ts';
import { readWatchClaim, WATCH_CLAIM_FILENAME, WATCH_HEARTBEAT_INTERVAL_MS, WatchClaimDatabase } from '../../src/watch-claim.ts';
import { runCli } from '../lib/cli.ts';
import { tmpTree, writeNote } from '../lib/tree.ts';

const dirs: string[] = [];
function tree(): string {
  const dir = tmpTree();
  dirs.push(dir);
  return dir;
}

function cfgFor(baseDir: string): ResolvedConfig {
  return { presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null };
}

function readClaim(cfg: ResolvedConfig) {
  return readWatchClaim(cfg.configDir ?? cfg.baseDir);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls fn until it returns a truthy value, or throws past timeoutMs.
async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 2000, stepMs = 5): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await sleep(stepMs);
  }
}

// Starts a watcher, collecting every event; `ready` resolves only once runWatch's setup
// (including its signal/SIGINT listeners) has fully run, so callers can abort() safely after it.
function startWatch(cfg: ResolvedConfig, opts: WatchOptions = {}) {
  const events: WatchEvent[] = [];
  let resolveStarted: () => void;
  const startedEvent = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const done = runWatch(cfg, {
    ...opts,
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'started') resolveStarted();
      opts.onEvent?.(event);
    },
  });
  const outcome = Promise.allSettled([done]).then(([result]) => result);
  const ready = Promise.race([
    startedEvent.then(() => sleep(0)),
    outcome.then((result) => {
      if (result.status === 'rejected') throw result.reason;
      throw new Error('runWatch resolved before emitting started');
    }),
  ]);
  return { done, events, outcome, ready };
}

describe('runWatch', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('clean shutdown via AbortSignal resolves the promise and releases the claim', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal });
    await ready;
    controller.abort();
    await done;
    assert.equal(readClaim(cfg), null);
  });

  it('the heartbeat advances the config-owned claim periodically', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal, heartbeatIntervalMs: 15 });
    try {
      await ready;
      const first = await waitUntil(() => readClaim(cfg));
      const firstMs = first.heartbeatMs;
      const second = await waitUntil(async () => {
        const value = readClaim(cfg);
        return value && value.heartbeatMs > firstMs ? value : null;
      });
      assert.ok(second.heartbeatMs > firstMs, 'heartbeat timestamp should advance between reads');
      assert.equal(second.pid, process.pid);
    } finally {
      controller.abort();
      await done;
    }
  });

  it('caps claim renewal at the shipped interval when reconciliation is requested less often', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, events, ready } = startWatch(cfg, { signal: controller.signal, heartbeatIntervalMs: 60_000 });
    try {
      await ready;
      const first = await waitUntil(() => readClaim(cfg));
      const before = events.length;
      const renewed = await waitUntil(
        () => {
          const value = readClaim(cfg);
          return value && value.token === first.token && value.heartbeatMs > first.heartbeatMs ? value : null;
        },
        2 * WATCH_HEARTBEAT_INTERVAL_MS + 2_000
      );
      assert.equal(renewed.token, first.token);
      const contender = new WatchClaimDatabase(baseDir);
      try {
        await assert.rejects(contender.acquire('slow-contender', process.pid, false), (err: unknown) => {
          assert.ok(err instanceof SenseError);
          assert.equal(err.code, 'WATCH_ACTIVE');
          return true;
        });
      } finally {
        contender.release('slow-contender');
        contender.close();
      }
      assert.equal(readClaim(cfg)?.token, first.token);
      assert.deepEqual(
        events.slice(before).filter((event) => event.type === 'reconciled'),
        [],
        'the slower reconcile interval must remain independent from claim renewal'
      );
    } finally {
      controller.abort();
      await done;
    }
  });

  it('rejects invalid heartbeat intervals before creating coordinator state', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    for (const heartbeatIntervalMs of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
      await assert.rejects(runWatch(cfg, { heartbeatIntervalMs }), (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'CONFIG_INVALID');
        return true;
      });
    }
    assert.equal(existsSync(join(baseDir, WATCH_CLAIM_FILENAME)), false);
  });

  it('aborting while the heartbeat is active shuts down cleanly', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);

    // Overlap with an in-flight tick is exercised deterministically by test/unit/lib/guarded-tick.test.ts;
    // this only checks shutdown still completes cleanly with the heartbeat running, as a cheap backstop.
    const caught: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => caught.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const controller = new AbortController();
      const { done, ready } = startWatch(cfg, { signal: controller.signal, heartbeatIntervalMs: 5 });
      await ready;
      await sleep(10);
      controller.abort();
      await done;
      assert.equal(readClaim(cfg), null);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
    assert.deepEqual(caught, [], 'no unhandled rejection should occur while aborting with the heartbeat active');
  });

  it('a file change triggers a debounced reconcile and emits reconciled', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready, events } = startWatch(cfg, { signal: controller.signal, debounceMs: 15 });
    await ready;

    const before = events.length;
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const event = await waitUntil(() => events.slice(before).find((e) => e.type === 'reconciled'));
    assert.equal(event.type, 'reconciled');
    if (event.type === 'reconciled') assert.equal(event.parsed, 1);

    controller.abort();
    await done;
  });

  it('writes inside the state dir do not retrigger reconcile', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    // One write into the state dir, then quiet for longer than the debounce: unguarded, that single
    // event schedules a reconcile which fires inside the window. A repeated heartbeat cannot show this (writes at the debounce interval keep resetting the timer), so the heartbeat is parked.
    const { done, ready, events } = startWatch(cfg, { signal: controller.signal, debounceMs: 15, heartbeatIntervalMs: 10_000 });
    await ready;
    const before = events.length;
    writeFileSync(join(baseDir, STATE_DIR, 'probe.tmp'), 'x');
    await sleep(120);
    controller.abort();
    await done;

    assert.deepEqual(
      events.slice(before).filter((e) => e.type === 'reconciled'),
      []
    );
  });

  // The reconcile owns the store, and past the pooling threshold a live worker pool too. The
  // tree is large enough to make the reconcile a real pooled one, so shutdown cannot close the connection its writes still need.
  it('shutdown drains a reconcile that is already in flight instead of closing the store underneath it', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready, events } = startWatch(cfg, { signal: controller.signal, debounceMs: 15 });
    await ready;

    for (let i = 0; i < 300; i++) writeNote(baseDir, `n${i}.md`, { frontmatter: { [`k${i}`]: 1 } });
    await sleep(40);
    controller.abort();
    await done;

    // Shutdown must not resolve until that reconcile has reported: undrained, `done` settles
    // while the reparse is still running and no reconciled event has been emitted yet.
    assert.ok(
      events.some((e) => e.type === 'reconciled'),
      'shutdown resolved before the in-flight reconcile reported'
    );
    assert.deepEqual(
      events.filter((e) => e.type === 'reconcile-error'),
      []
    );
    assert.equal(readClaim(cfg), null);
  });

  it('WATCH_ACTIVE throws when a fresh claim exists; force replaces its token safely', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const existing = new WatchClaimDatabase(baseDir);

    try {
      await existing.acquire('existing-owner', process.pid, false);
      await assert.rejects(runWatch(cfg, {}), (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'WATCH_ACTIVE');
        return true;
      });

      const controller = new AbortController();
      const { done, ready } = startWatch(cfg, { signal: controller.signal, force: true });
      try {
        await ready;
        assert.notEqual(readClaim(cfg)?.token, 'existing-owner');
        assert.equal(existing.renew('existing-owner'), false);
        assert.equal(existing.release('existing-owner'), false);
      } finally {
        controller.abort();
        await done;
      }
    } finally {
      existing.release('existing-owner');
      existing.close();
    }
  });

  it('a forced replacement makes the old watcher drain and reject without clearing the new claim', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = startWatch(cfg, { signal: firstController.signal, heartbeatIntervalMs: 15 });
    let second: ReturnType<typeof startWatch> | undefined;
    let bodyFailed = false;
    let bodyFailure: unknown;
    let cleanupResults: [PromiseSettledResult<void>, PromiseSettledResult<void> | null] | null = null;
    try {
      await first.ready;
      const firstToken = readClaim(cfg)?.token;
      second = startWatch(cfg, { force: true, signal: secondController.signal, heartbeatIntervalMs: 15 });
      await second.ready;
      const secondToken = readClaim(cfg)?.token;
      assert.ok(firstToken);
      assert.ok(secondToken);
      assert.notEqual(secondToken, firstToken);
      await assert.rejects(first.done, (err: unknown) => {
        assert.ok(err instanceof SenseError);
        assert.equal(err.code, 'WATCH_ACTIVE');
        return true;
      });
      assert.equal(readClaim(cfg)?.token, secondToken, 'old watcher cleanup must not release the new claim');
    } catch (err) {
      bodyFailed = true;
      bodyFailure = err;
    } finally {
      firstController.abort();
      secondController.abort();
      cleanupResults = await Promise.all([first.outcome, second?.outcome ?? Promise.resolve(null)]);
    }

    if (!cleanupResults) throw new Error('watcher cleanup outcomes were not recorded');
    const [firstResult, secondResult] = cleanupResults;
    const cleanupFailures: unknown[] = [];
    if (firstResult.status === 'rejected' && (!second || !(firstResult.reason instanceof SenseError) || firstResult.reason.code !== 'WATCH_ACTIVE')) cleanupFailures.push(firstResult.reason);
    if (secondResult?.status === 'rejected') cleanupFailures.push(secondResult.reason);
    if (bodyFailed) {
      if (cleanupFailures.length > 0) throw new AggregateError([bodyFailure, ...cleanupFailures], 'forced watcher replacement and cleanup failed');
      throw bodyFailure;
    }
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures, 'forced watcher replacement cleanup failed');
  });

  it('rejects a coordinator startup failure without opening the search store', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    mkdirSync(join(baseDir, WATCH_CLAIM_FILENAME));
    await assert.rejects(runWatch(cfg), /database|directory|open/i);
    assert.equal(existsSync(join(baseDir, STATE_DIR)), false);
  });

  // duckdb locks its cache file per connection; the watcher must hold nothing between events, or
  // this second process would fail with STORE_BUSY.
  it('a second command succeeds while a watcher idles on a duckdb tree', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    writeFileSync(join(baseDir, 'sense.config.json'), JSON.stringify({ version: 5, store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    const cfg = { ...cfgFor(baseDir), store: 'duckdb' } as ResolvedConfig;
    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal });
    await ready;

    const result = runCli(['status'], { cwd: baseDir });
    assert.equal(result.status, 0, result.stderr);

    controller.abort();
    await done;
  });
});
