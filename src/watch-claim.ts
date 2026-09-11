import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { SenseError } from './errors.ts';
import { resolveWorkerFile } from './lib/worker-file.ts';
import { reviveError, type WorkerErrorPayload } from './scan/worker-error.ts';
import { createConnection } from './store/sqlite/connection.ts';
import { BEGIN_WRITE, withTransaction } from './store/transaction.ts';

export const WATCH_CLAIM_FILENAME = '.sense-watch.db';
export const WATCH_HEARTBEAT_INTERVAL_MS = 5_000;
export const WATCH_STALE_HEARTBEAT_MS = 15_000;
const CLAIM_BUSY_TIMEOUT_MS = 30_000;

export interface WatchClaimRecord {
  token: string;
  pid: number;
  heartbeatMs: number;
}

interface ClaimRow {
  token: string;
  pid: number;
  heartbeat_ms: number;
}

export interface WatchClaimWorkerData {
  configDir: string;
  force: boolean;
  heartbeatIntervalMs: number;
  pid: number;
  token: string;
}

export type WatchClaimWorkerMessage = { type: 'acquired' } | { type: 'stopped' } | { type: 'failure'; error: WorkerErrorPayload };

export interface WatchClaimController {
  close(): Promise<void>;
}

function claimPath(configDir: string): string {
  return join(configDir, WATCH_CLAIM_FILENAME);
}

function changedOne(changes: number | bigint): boolean {
  return changes === 1 || changes === BigInt(1);
}

// This database is separate from the selected search store so its heartbeat remains writable while
// a DuckDB, Turso, or SQLite reconciliation owns the cache connection or blocks the main thread.
export class WatchClaimDatabase {
  private readonly db: DatabaseSync;
  private readonly conn: ReturnType<typeof createConnection>;

  constructor(configDir: string) {
    const db = new DatabaseSync(claimPath(configDir));
    try {
      db.exec(`PRAGMA busy_timeout = ${CLAIM_BUSY_TIMEOUT_MS}`);
      db.exec('CREATE TABLE IF NOT EXISTS watch_claim (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), token TEXT NOT NULL, pid INTEGER NOT NULL, heartbeat_ms INTEGER NOT NULL)');
    } catch (err) {
      try {
        db.close();
      } catch (closeError) {
        throw new AggregateError([err, closeError], 'watch claim setup and database cleanup both failed');
      }
      throw err;
    }
    this.db = db;
    this.conn = createConnection(db);
  }

  async acquire(token: string, pid: number, force: boolean): Promise<void> {
    await withTransaction(
      this.conn,
      async () => {
        const current = this.db.prepare('SELECT token, pid, heartbeat_ms FROM watch_claim WHERE singleton = 1').get() as ClaimRow | undefined;
        if (current && !force) {
          const age = Date.now() - current.heartbeat_ms;
          if (age >= 0 && age < WATCH_STALE_HEARTBEAT_MS) throw new SenseError('WATCH_ACTIVE', `another watcher appears active (heartbeat ${Math.round(age / 1000)}s ago); use --force to override`);
        }
        this.db.prepare('INSERT INTO watch_claim (singleton, token, pid, heartbeat_ms) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET token = excluded.token, pid = excluded.pid, heartbeat_ms = excluded.heartbeat_ms').run(token, pid, Date.now());
      },
      BEGIN_WRITE
    );
  }

  renew(token: string): boolean {
    return changedOne(this.db.prepare('UPDATE watch_claim SET heartbeat_ms = ? WHERE singleton = 1 AND token = ?').run(Date.now(), token).changes);
  }

  release(token: string): boolean {
    return changedOne(this.db.prepare('DELETE FROM watch_claim WHERE singleton = 1 AND token = ?').run(token).changes);
  }

  read(): WatchClaimRecord | null {
    const row = this.db.prepare('SELECT token, pid, heartbeat_ms FROM watch_claim WHERE singleton = 1').get() as ClaimRow | undefined;
    return row ? { token: row.token, pid: row.pid, heartbeatMs: row.heartbeat_ms } : null;
  }

  close(): void {
    this.db.close();
  }
}

// Status opens the coordinator read-only and therefore cannot create either the file or its schema.
export function readWatchClaim(configDir: string): WatchClaimRecord | null {
  const path = claimPath(configDir);
  if (!existsSync(path)) return null;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    if (!existsSync(path)) return null;
    throw err;
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${CLAIM_BUSY_TIMEOUT_MS}`);
    const row = db.prepare('SELECT token, pid, heartbeat_ms FROM watch_claim WHERE singleton = 1').get() as ClaimRow | undefined;
    return row ? { token: row.token, pid: row.pid, heartbeatMs: row.heartbeat_ms } : null;
  } catch (err) {
    if (/no such table: watch_claim/.test((err as Error).message)) return null;
    throw err;
  } finally {
    db.close();
  }
}

export async function startWatchClaim(configDir: string, force: boolean, heartbeatIntervalMs: number, onFailure: (err: Error) => void): Promise<WatchClaimController> {
  const workerData: WatchClaimWorkerData = { configDir, force, heartbeatIntervalMs, pid: process.pid, token: randomUUID() };
  const worker = new Worker(resolveWorkerFile('watch-heartbeat'), { workerData });
  let acquired = false;
  let closing = false;
  let exited = false;
  let failureReported = false;
  let closeError: Error | null = null;
  let closePromise: Promise<void> | undefined;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let resolveStart!: () => void;
  let rejectStart!: (err: Error) => void;
  const start = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });

  const fail = (err: Error): void => {
    if (failureReported) return;
    failureReported = true;
    if (!acquired) rejectStart(err);
    else if (closing) closeError ??= err;
    else onFailure(err);
  };
  worker.on('message', (message: WatchClaimWorkerMessage) => {
    if (message.type === 'acquired') {
      acquired = true;
      resolveStart();
    } else if (message.type === 'failure') {
      fail(reviveError(message.error));
    }
  });
  worker.on('error', fail);
  worker.on('exit', (code) => {
    exited = true;
    resolveExit();
    if (closing && code !== 0) closeError ??= new Error(`watch heartbeat worker stopped with exit code ${code}`);
    else if (!closing && !failureReported) fail(new Error(`watch heartbeat worker stopped unexpectedly with exit code ${code}`));
  });

  try {
    await start;
  } catch (err) {
    closing = true;
    if (!exited) await worker.terminate();
    await exit;
    throw err;
  }

  return {
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true;
        if (!exited) {
          try {
            worker.postMessage({ type: 'stop' });
          } catch (err) {
            closeError ??= err instanceof Error ? err : new Error(String(err));
            await worker.terminate();
          }
        }
        await exit;
        if (closeError) throw closeError;
      })();
      return closePromise;
    },
  };
}
