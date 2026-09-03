import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { type ResolvedConfig, STATE_DIR } from '../../src/config/index.ts';
import { SenseError } from '../../src/errors.ts';
import { getMeta, openStore, setMeta } from '../../src/store/index.ts';
import type { WatchEvent, WatchOptions } from '../../src/watch.ts';
import { runWatch } from '../../src/watch.ts';
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

async function readMeta(cfg: ResolvedConfig, key: string): Promise<string | null> {
  const { store } = await openStore(cfg);
  const value = await getMeta(store, key);
  await store.close();
  return value;
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
  const ready = startedEvent.then(() => sleep(0));
  return { done, events, ready };
}

describe('runWatch', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) safeRmSync(dir, { recursive: true, force: true });
  });

  it('clean shutdown via AbortSignal resolves the promise and clears watch_heartbeat/watch_pid', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal });
    await ready;
    controller.abort();
    await done;
    assert.equal(await readMeta(cfg, 'watch_heartbeat'), null);
    assert.equal(await readMeta(cfg, 'watch_pid'), null);
  });

  it('the heartbeat writes watch_heartbeat/watch_pid periodically', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = cfgFor(baseDir);
    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal, heartbeatIntervalMs: 15 });
    await ready;

    const first = await waitUntil(() => readMeta(cfg, 'watch_heartbeat'));
    const firstMs = Date.parse(first);
    const second = await waitUntil(async () => {
      const value = await readMeta(cfg, 'watch_heartbeat');
      return value && Date.parse(value) > firstMs ? value : null;
    });
    assert.ok(Date.parse(second) > firstMs, 'heartbeat timestamp should advance between reads');
    assert.equal(await readMeta(cfg, 'watch_pid'), String(process.pid));

    controller.abort();
    await done;
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
      assert.equal(await readMeta(cfg, 'watch_heartbeat'), null);
      assert.equal(await readMeta(cfg, 'watch_pid'), null);
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
    assert.equal(await readMeta(cfg, 'watch_heartbeat'), null);
  });

  it('WATCH_ACTIVE throws when a fresh heartbeat exists; force overrides it', async () => {
    const baseDir = tree();
    const cfg = cfgFor(baseDir);
    const { store } = await openStore(cfg);
    await setMeta(store, 'watch_heartbeat', new Date().toISOString());
    await store.close();

    await assert.rejects(runWatch(cfg, {}), (err: unknown) => {
      assert.ok(err instanceof SenseError);
      assert.equal((err as SenseError).code, 'WATCH_ACTIVE');
      return true;
    });

    const controller = new AbortController();
    const { done, ready } = startWatch(cfg, { signal: controller.signal, force: true });
    await ready;
    controller.abort();
    await done;
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
