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

// Runs in the foreground until SIGINT/SIGTERM/signal abort. Throws WATCH_ACTIVE if another watcher's heartbeat is still fresh and --force wasn't given.
export async function runWatch(cfg: ResolvedConfig, opts: WatchOptions = {}): Promise<void> {
  const onEvent = opts.onEvent ?? (() => {});
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const { store, dbPath, warnings: initialWarnings, parsed: initialParsed } = await openStore(cfg);
  const baseDir = cfg.baseDir;

  const existingHeartbeat = await getMeta(store, 'watch_heartbeat');
  if (existingHeartbeat && !opts.force) {
    const age = Date.now() - Date.parse(existingHeartbeat);
    if (age >= 0 && age < STALE_HEARTBEAT_MS) {
      await store.close();
      throw new SenseError('WATCH_ACTIVE', `another watcher appears active (heartbeat ${Math.round(age / 1000)}s ago); use --force to override`);
    }
  }

  onEvent({ type: 'started', baseDir, dbPath });
  if (initialWarnings.length > 0 || initialParsed > 0) {
    onEvent({ type: 'reconciled', parsed: initialParsed, total: await docCount(store), warnings: initialWarnings });
  }

  let stopping = false;
  const touchHeartbeat = async () => {
    await setMeta(store, 'watch_heartbeat', new Date().toISOString());
    await setMeta(store, 'watch_pid', String(process.pid));
  };
  await touchHeartbeat();

  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleReconcile = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      debounceTimer = null;
      try {
        const { parsed, warnings } = await store.reconcile();
        onEvent({ type: 'reconciled', parsed, total: await docCount(store), warnings });
      } catch (err) {
        onEvent({ type: 'reconcile-error', message: (err as Error).message });
      }
    }, debounceMs);
  };

  // Ignore our own state dir, or the heartbeat write would retrigger itself forever.
  const watcher = fsWatch(baseDir, { recursive: true }, (_event, filename) => {
    if (typeof filename === 'string' && filename.startsWith(STATE_DIR)) return;
    scheduleReconcile();
  });
  const heartbeatTimer = setInterval(
    guardedTick(touchHeartbeat, () => stopping),
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
      await setMeta(store, 'watch_heartbeat', null);
      await setMeta(store, 'watch_pid', null);
      await store.close();
      resolveShutdown();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    if (opts.signal?.aborted) shutdown();
    else opts.signal?.addEventListener('abort', shutdown, { once: true });
  });
}
