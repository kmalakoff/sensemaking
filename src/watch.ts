import { watch as fsWatch } from 'node:fs';
import type { ResolvedConfig } from './config/index.ts';
import { STATE_DIR } from './config/index.ts';
import { SenseError } from './errors.ts';
import { guardedTick } from './lib/guarded-tick.ts';
import { docCount, getMeta, openStore, setMeta } from './store/index.ts';

// Watch is a cache pre-warmer, not a correctness mechanism: open() always reconciles anyway, so any fs event just triggers a debounced full reconcile.
const DEBOUNCE_MS = 200;
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_HEARTBEAT_MS = 15000;

export type WatchEvent = { type: 'started'; baseDir: string; dbPath: string } | { type: 'reconciled'; parsed: number; total: number; warnings: string[] } | { type: 'reconcile-error'; message: string };

export interface WatchOptions {
  force?: boolean;
  onEvent?: (event: WatchEvent) => void;
  // Aborting runs the same shutdown path as SIGINT/SIGTERM.
  signal?: AbortSignal;
  debounceMs?: number;
  heartbeatIntervalMs?: number;
}

// Runs in the foreground until SIGINT/SIGTERM/signal abort. duckdb/turso hand the cache file to
// one process at a time, so every cycle opens, reconciles, writes the heartbeat/pid rows, and closes.
export async function runWatch(cfg: ResolvedConfig, opts: WatchOptions = {}): Promise<void> {
  const onEvent = opts.onEvent ?? (() => {});
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const baseDir = cfg.baseDir;

  const { store: initialStore, dbPath, warnings: initialWarnings, parsed: initialParsed } = await openStore(cfg);
  const existingHeartbeat = await getMeta(initialStore, 'watch_heartbeat');
  if (existingHeartbeat && !opts.force) {
    const age = Date.now() - Date.parse(existingHeartbeat);
    if (age >= 0 && age < STALE_HEARTBEAT_MS) {
      await initialStore.close();
      throw new SenseError('WATCH_ACTIVE', `another watcher appears active (heartbeat ${Math.round(age / 1000)}s ago); use --force to override`);
    }
  }

  // total is read before close: an event fires only once nothing is held open again.
  const initialTotal = initialWarnings.length > 0 || initialParsed > 0 ? await docCount(initialStore) : 0;
  await setMeta(initialStore, 'watch_heartbeat', new Date().toISOString());
  await setMeta(initialStore, 'watch_pid', String(process.pid));
  await initialStore.close();

  onEvent({ type: 'started', baseDir, dbPath });
  if (initialWarnings.length > 0 || initialParsed > 0) {
    onEvent({ type: 'reconciled', parsed: initialParsed, total: initialTotal, warnings: initialWarnings });
  }

  let stopping = false;
  // At most one open+reconcile+close cycle runs at a time; a trigger that arrives mid-cycle is
  // coalesced into a single rerun instead of opening a second, overlapping connection.
  let running: Promise<void> | null = null;
  let queuedAlways: boolean | null = null;

  const tick = async (alwaysEmit: boolean): Promise<void> => {
    try {
      const { store, parsed, warnings } = await openStore(cfg);
      try {
        await setMeta(store, 'watch_heartbeat', new Date().toISOString());
        await setMeta(store, 'watch_pid', String(process.pid));
        if (alwaysEmit || parsed > 0 || warnings.length > 0) {
          onEvent({ type: 'reconciled', parsed, total: await docCount(store), warnings });
        }
      } finally {
        await store.close();
      }
    } catch (err) {
      onEvent({ type: 'reconcile-error', message: (err as Error).message });
    }
  };

  const startCycle = (alwaysEmit: boolean) => {
    running = tick(alwaysEmit).then(() => {
      running = null;
      if (queuedAlways !== null && !stopping) {
        const again = queuedAlways;
        queuedAlways = null;
        startCycle(again);
      }
    });
  };

  const requestCycle = (alwaysEmit: boolean) => {
    if (stopping) return;
    if (running) {
      queuedAlways = queuedAlways || alwaysEmit;
      return;
    }
    startCycle(alwaysEmit);
  };

  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleReconcile = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      requestCycle(true);
    }, debounceMs);
  };

  // Ignore our own state dir, or the heartbeat write would retrigger itself forever. An event with
  // an unresolvable filename (null, which fs.watch delivers under load) reconciles: parsing nothing costs less than missing a real edit.
  const watcher = fsWatch(baseDir, { recursive: true }, (_event, filename) => {
    if (typeof filename === 'string' && filename.startsWith(STATE_DIR)) return;
    scheduleReconcile();
  });
  const heartbeatTimer = setInterval(
    guardedTick(
      async () => requestCycle(false),
      () => stopping
    ),
    heartbeatIntervalMs
  );

  return new Promise<void>((resolveShutdown) => {
    // SIGINT/SIGTERM and an aborted signal all run this same path exactly once; each is
    // unregistered here too so a second runWatch call in the same process starts clean.
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      opts.signal?.removeEventListener('abort', shutdown);
      clearInterval(heartbeatTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      await running;
      const { store: finalStore } = await openStore(cfg);
      await setMeta(finalStore, 'watch_heartbeat', null);
      await setMeta(finalStore, 'watch_pid', null);
      await finalStore.close();
      resolveShutdown();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (opts.signal?.aborted) shutdown();
    else opts.signal?.addEventListener('abort', shutdown, { once: true });
  });
}
