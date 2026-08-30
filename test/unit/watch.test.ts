import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { type ResolvedConfig, STATE_DIR } from '../../src/config/index.ts';
import { SenseError } from '../../src/errors.ts';
import { getMeta, openStore, setMeta } from '../../src/store/index.ts';
import type { WatchEvent, WatchOptions } from '../../src/watch.ts';
import { runWatch } from '../../src/watch.ts';
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
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

    // Overlap with an in-flight tick is exercised deterministically by
    // test/unit/lib/guarded-tick.test.ts; this only checks shutdown still completes cleanly
    // with the heartbeat running. The probe costs nothing, so it stays as a cheap backstop.
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
    // A short heartbeat interval keeps writing into .sense/cache.db while the watcher runs,
    // exercising the self-retrigger guard for real rather than only for the note files.
    const { done, ready, events } = startWatch(cfg, { signal: controller.signal, debounceMs: 15, heartbeatIntervalMs: 15 });
    await ready;
    await sleep(100);
    controller.abort();
    await done;

    assert.equal(events.filter((e) => e.type === 'reconciled').length, 0);
  });

  it('a store without watch-concurrency errors before opening, naming the config fix', async () => {
    const baseDir = tree();
    writeNote(baseDir, 'a.md');
    const cfg = { ...cfgFor(baseDir), store: 'duckdb' } as ResolvedConfig;
    await assert.rejects(runWatch(cfg, {}), (err: unknown) => {
      assert.ok(err instanceof SenseError);
      assert.equal(err.code, 'STORE_CAPABILITY_MISSING');
      assert.match(err.message, /"store" to "sqlite"/);
      return true;
    });
    assert.equal(existsSync(join(baseDir, STATE_DIR)), false, 'the check runs before open, so no cache exists');
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
});
