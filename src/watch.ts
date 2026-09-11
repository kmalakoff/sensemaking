import { watch as fsWatch } from 'node:fs';
import type { ResolvedConfig } from './config/index.ts';
import { STATE_DIR } from './config/index.ts';
import { SenseError } from './errors.ts';
import { guardedTick } from './lib/guarded-tick.ts';
import { docCount, openStore } from './store/index.ts';
import { startWatchClaim, WATCH_HEARTBEAT_INTERVAL_MS } from './watch-claim.ts';

// Watch is a cache pre-warmer, not a correctness mechanism: open() always reconciles anyway, so any fs event just triggers a debounced full reconcile.
const DEBOUNCE_MS = 200;

export type WatchEvent = { type: 'started'; rootDir: string; dbPath: string } | { type: 'reconciled'; parsed: number; total: number; warnings: string[] } | { type: 'reconcile-error'; message: string };

export interface WatchOptions {
  force?: boolean;
  onEvent?: (event: WatchEvent) => void;
  // Aborting runs the same shutdown path as SIGINT/SIGTERM.
  signal?: AbortSignal;
  debounceMs?: number;
  heartbeatIntervalMs?: number;
}

// Runs in the foreground until SIGINT/SIGTERM/signal abort. DuckDB and Turso hand the cache file to
// one process at a time, so every reconcile cycle opens and closes instead of holding an idle lock.
export async function runWatch(cfg: ResolvedConfig, opts: WatchOptions = {}): Promise<void> {
  const onEvent = opts.onEvent ?? (() => {});
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const reconcileIntervalMs = opts.heartbeatIntervalMs ?? WATCH_HEARTBEAT_INTERVAL_MS;
  if (!Number.isFinite(reconcileIntervalMs) || reconcileIntervalMs <= 0) throw new SenseError('CONFIG_INVALID', 'watch heartbeatIntervalMs must be a finite positive number');
  // Reconciliation may be parked for a caller, but live ownership must renew before fixed expiry.
  const claimIntervalMs = Math.min(reconcileIntervalMs, WATCH_HEARTBEAT_INTERVAL_MS);
  const rootDir = cfg.rootDir ?? cfg.baseDir;
  const configDir = cfg.configDir ?? rootDir;
  let claimFailure: Error | null = null;
  let requestShutdown: ((reason: Error) => void) | undefined;
  const claim = await startWatchClaim(configDir, opts.force ?? false, claimIntervalMs, (err) => {
    claimFailure ??= err;
    requestShutdown?.(err);
  });
  let claimCloseStarted = false;
  const closeClaim = (): Promise<void> => {
    claimCloseStarted = true;
    return claim.close();
  };
  try {
    const { store: initialStore, dbPath, warnings: initialWarnings, parsed: initialParsed } = await openStore(cfg);
    let initialTotal = 0;
    try {
      // total is read before close: an event fires only once nothing is held open again.
      initialTotal = initialWarnings.length > 0 || initialParsed > 0 ? await docCount(initialStore) : 0;
    } finally {
      await initialStore.close();
    }
    if (claimFailure) throw claimFailure;

    let stopping = false;
    // At most one open+reconcile+close cycle runs at a time; a trigger that arrives mid-cycle is
    // coalesced into a single rerun instead of opening a second, overlapping connection.
    let running: Promise<void> | null = null;
    let queuedAlways: boolean | null = null;

    const tick = async (alwaysEmit: boolean): Promise<void> => {
      try {
        const { store, parsed, warnings } = await openStore(cfg);
        try {
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

    // Ignore our own state files, or cache and claim writes would retrigger reconciliation forever.
    // An unresolvable filename reconciles because parsing nothing costs less than missing a real edit.
    const watcher = fsWatch(rootDir, { recursive: true }, (_event, filename) => {
      if (typeof filename === 'string' && filename.startsWith(STATE_DIR)) return;
      scheduleReconcile();
    });
    const reconcileTimer = setInterval(
      guardedTick(
        async () => requestCycle(false),
        () => stopping
      ),
      reconcileIntervalMs
    );

    return await new Promise<void>((resolveShutdown, rejectShutdown) => {
      let shutdownReason: Error | null = null;
      const shutdown = (reason?: Error) => {
        shutdownReason ??= reason ?? null;
        if (stopping) return;
        stopping = true;
        const shutdownTask = (async () => {
          process.off('SIGINT', stopNormally);
          process.off('SIGTERM', stopNormally);
          opts.signal?.removeEventListener('abort', stopNormally);
          clearInterval(reconcileTimer);
          if (debounceTimer) clearTimeout(debounceTimer);
          watcher.close();
          await running;
          let finalError: unknown;
          try {
            // A normal stop performs one final freshness pass. Ownership loss drains existing work
            // but starts nothing new because the replacement watcher now owns that responsibility.
            if (!shutdownReason) {
              const { store: finalStore } = await openStore(cfg);
              await finalStore.close();
            }
          } catch (err) {
            finalError = err;
          }
          try {
            await closeClaim();
          } catch (err) {
            if (finalError) throw new AggregateError([finalError, err], 'watch shutdown and claim cleanup both failed');
            throw err;
          }
          if (finalError) throw finalError;
          if (shutdownReason) throw shutdownReason;
        })();
        shutdownTask.then(resolveShutdown, rejectShutdown);
      };
      const stopNormally = () => shutdown();
      requestShutdown = shutdown;
      process.once('SIGINT', stopNormally);
      process.once('SIGTERM', stopNormally);
      if (claimFailure) shutdown(claimFailure);
      else if (opts.signal?.aborted) shutdown();
      else {
        opts.signal?.addEventListener('abort', stopNormally, { once: true });
        try {
          onEvent({ type: 'started', rootDir, dbPath });
          if (!stopping && (initialWarnings.length > 0 || initialParsed > 0)) {
            onEvent({ type: 'reconciled', parsed: initialParsed, total: initialTotal, warnings: initialWarnings });
          }
        } catch (err) {
          shutdown(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
  } catch (err) {
    if (claimCloseStarted) throw err;
    try {
      await closeClaim();
    } catch (closeError) {
      throw new AggregateError([err, closeError], 'watch setup and claim cleanup both failed');
    }
    throw err;
  } finally {
    requestShutdown = undefined;
  }
}
