import { watch as fsWatch } from 'node:fs';
import type { ResolvedConfig } from './config.ts';
import { STATE_DIR } from './config.ts';
import { docCount, getMeta, open, reconcile, setMeta } from './db.ts';
import { SenseError } from './errors.ts';

// Watch is a cache pre-warmer, not a correctness mechanism: every query
// `open()` reconciles against the filesystem regardless, so a missed or
// coalesced fs event can never change a query result -- it only moves one
// file's parse from ahead-of-time to query-time. That's why any event, of
// any kind, triggers the exact same response: a debounced full reconcile.
// Per-file event handling would be complexity with no correctness payoff.
const DEBOUNCE_MS = 200;
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_HEARTBEAT_MS = 15000;

// This module never prints -- it emits events via `onEvent` and throws on
// the one exit-worthy condition (a live watcher already present). cli.ts is
// the only place that touches console/process.exit.
export type WatchEvent = { type: 'started'; baseDir: string; dbPath: string } | { type: 'reconciled'; parsed: number; total: number; warnings: string[] } | { type: 'reconcile-error'; message: string };

export interface WatchOptions {
  force?: boolean;
  onEvent?: (event: WatchEvent) => void;
}

// Runs in the foreground until SIGINT/SIGTERM; never forks or daemonizes --
// process lifecycle belongs to the OS (launchd/systemd/terminal). Resolves
// on clean shutdown; throws SenseError("WATCH_ACTIVE", ...) if another
// watcher's heartbeat is still fresh and `--force` wasn't given.
export async function runWatch(cfg: ResolvedConfig, opts: WatchOptions = {}): Promise<void> {
  const onEvent = opts.onEvent ?? (() => {});
  const { db, dbPath, warnings: initialWarnings, parsed: initialParsed } = open(cfg);
  const baseDir = cfg.baseDir;

  const existingHeartbeat = getMeta(db, 'watch_heartbeat');
  if (existingHeartbeat && !opts.force) {
    const age = Date.now() - Date.parse(existingHeartbeat);
    if (age >= 0 && age < STALE_HEARTBEAT_MS) {
      db.close();
      throw new SenseError('WATCH_ACTIVE', `another watcher appears active (heartbeat ${Math.round(age / 1000)}s ago); use --force to override`);
    }
  }

  onEvent({ type: 'started', baseDir, dbPath });
  if (initialWarnings.length > 0 || initialParsed > 0) {
    onEvent({ type: 'reconciled', parsed: initialParsed, total: docCount(db), warnings: initialWarnings });
  }

  const touchHeartbeat = () => {
    setMeta(db, 'watch_heartbeat', new Date().toISOString());
    setMeta(db, 'watch_pid', String(process.pid));
  };
  touchHeartbeat();

  let debounceTimer: NodeJS.Timeout | null = null;
  const scheduleReconcile = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        const { parsed, warnings } = reconcile(db, cfg, baseDir);
        onEvent({ type: 'reconciled', parsed, total: docCount(db), warnings });
      } catch (err) {
        onEvent({ type: 'reconcile-error', message: (err as Error).message });
      }
    }, DEBOUNCE_MS);
  };

  // Ignore events from our own state dir: the heartbeat writes cache.db
  // every few seconds, and without this filter each write would schedule a
  // (harmless but pointless) reconcile forever — a perpetual self-trigger.
  const watcher = fsWatch(baseDir, { recursive: true }, (_event, filename) => {
    if (typeof filename === 'string' && filename.startsWith(STATE_DIR)) return;
    scheduleReconcile();
  });
  const heartbeatTimer = setInterval(touchHeartbeat, HEARTBEAT_INTERVAL_MS);

  return new Promise<void>((resolveShutdown) => {
    const cleanExit = () => {
      clearInterval(heartbeatTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      watcher.close();
      setMeta(db, 'watch_heartbeat', null);
      setMeta(db, 'watch_pid', null);
      db.close();
      resolveShutdown();
    };
    process.once('SIGINT', cleanExit);
    process.once('SIGTERM', cleanExit);
  });
}
