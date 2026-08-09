import { watch as fsWatch } from 'node:fs';
import type { ResolvedConfig } from './config.ts';
import { STATE_DIR } from './config.ts';
import { docCount, getMeta, open, reconcile, setMeta } from './db.ts';
import { SenseError } from './errors.ts';

// Watch is a cache pre-warmer, not a correctness mechanism: open() always reconciles anyway, so any fs event just triggers a debounced full reconcile.
const DEBOUNCE_MS = 200;
const HEARTBEAT_INTERVAL_MS = 5000;
const STALE_HEARTBEAT_MS = 15000;

export type WatchEvent = { type: 'started'; baseDir: string; dbPath: string } | { type: 'reconciled'; parsed: number; total: number; warnings: string[] } | { type: 'reconcile-error'; message: string };

export interface WatchOptions {
  force?: boolean;
  onEvent?: (event: WatchEvent) => void;
}

// Runs in the foreground until SIGINT/SIGTERM. Throws WATCH_ACTIVE if another watcher's heartbeat is still fresh and --force wasn't given.
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

  // Ignore our own state dir, or the heartbeat write would retrigger itself forever.
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
