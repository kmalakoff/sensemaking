import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config/index.ts';

// duckdb/turso lock the cache file exclusively, so a waiter can't connect and read reconcile_max_ms
// from meta; this sidecar is plain fs, readable while locked. Same derivation as busy_timeout (open.ts).
const SIDECAR_FILENAME = 'lock-wait.json';
const FLOOR_MS = 5_000;
const CEILING_MS = 600_000;

function sidecarPath(configDir: string): string {
  return join(configDir, STATE_DIR, SIDECAR_FILENAME);
}

function readRecordedMs(configDir: string): number | undefined {
  try {
    const raw = JSON.parse(readFileSync(sidecarPath(configDir), 'utf8'));
    const value = raw.reconcile_max_ms;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// Called after every reconcile's write transaction, every store alike, so a fresh cache records
// its first write even when the measured duration is zero.
export function recordLockWaitMs(configDir: string, ms: number): void {
  const recordedMs = readRecordedMs(configDir);
  if (recordedMs !== undefined && ms <= recordedMs) return;
  try {
    writeFileSync(sidecarPath(configDir), JSON.stringify({ reconcile_max_ms: ms }));
  } catch {
    // Best-effort: a write failure here only narrows the next waiter's budget back to the floor.
  }
}

// 3x the largest reconcile this cache has recorded, floored and capped -- a waiter outlasts a
// real reconcile and still fails behind a hung one.
export function lockWaitBudgetMs(configDir: string): number {
  return Math.min(Math.max(FLOOR_MS, 3 * (readRecordedMs(configDir) ?? 0)), CEILING_MS);
}
