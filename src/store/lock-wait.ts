import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config/index.ts';

// duckdb/turso lock the cache file exclusively, so a waiter can't connect and read reconcile_max_ms
// from meta; this sidecar is plain fs, readable while locked. Same derivation as busy_timeout (open.ts).
const SIDECAR_FILENAME = 'lock-wait.json';
const FLOOR_MS = 5_000;
const CEILING_MS = 600_000;

function sidecarPath(baseDir: string): string {
  return join(baseDir, STATE_DIR, SIDECAR_FILENAME);
}

function readRecordedMs(baseDir: string): number {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(baseDir), 'utf8'));
    return typeof raw.reconcile_max_ms === 'number' ? raw.reconcile_max_ms : 0;
  } catch {
    return 0;
  }
}

// Called after every reconcile's write transaction, every store alike, so a fresh duckdb/turso
// tree starts building this the first time anything writes.
export function recordLockWaitMs(baseDir: string, ms: number): void {
  if (ms <= readRecordedMs(baseDir)) return;
  try {
    writeFileSync(sidecarPath(baseDir), JSON.stringify({ reconcile_max_ms: ms }));
  } catch {
    // Best-effort: a write failure here only narrows the next waiter's budget back to the floor.
  }
}

// 3x the largest reconcile this tree has recorded, floored and capped -- a waiter outlasts a
// real reconcile and still fails behind a hung one.
export function lockWaitBudgetMs(baseDir: string): number {
  return Math.min(Math.max(FLOOR_MS, 3 * readRecordedMs(baseDir)), CEILING_MS);
}
