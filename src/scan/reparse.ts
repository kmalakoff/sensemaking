import { availableParallelism } from 'node:os';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import type { ParsedDoc } from './index.ts';
import { parseFile } from './index.ts';
import type { FileStat } from './list.ts';
import type { FileResult } from './pool.ts';
import { ParsePool } from './pool.ts';

// Store-agnostic per-file parse pass shared by every store's reconcile(). Index-preserving:
// one pass over `files`, pushed in order.
export interface ReparseResult {
  docs: ParsedDoc[];
  warnings: string[];
  // Frontmatter keys not in `knownColumns`, first-seen order -- the order callers ALTER TABLE ADD COLUMN in.
  newColumns: string[];
  // Sum of worker-side parseFile time (workers/parse.ts) across files; 0 on the serial path.
  workerParseMs: number;
}

export interface ReparseOptions {
  // Overrides PARSE_BYTES_PER_WORKER below. Zero forces worker dispatch in tests.
  // Internal: no caller in src/ passes it.
  threshold?: number;
  // Overrides DEFAULT_MAX_WORKERS below.
  maxWorkers?: number;
  // A builder-owned pool to dispatch through instead of creating and destroying one for this
  // call alone (see store/builder.ts). Absent, reparseFiles manages its own ephemeral pool.
  pool?: ParsePool;
}

// The 2026-09-26 comparison kept ~326 KiB updates serial and 5.86 MiB work pooled.
// Companion byte shares prevent one dominant file from selecting workers for a tiny remainder.
export const PARSE_BYTES_PER_WORKER = 512 * 1024;
const DEFAULT_MAX_WORKERS = 8;

// Per-file feature filtering, shared by the serial loop (reads `features` from the caller) and
// the worker path (can only pass `cfg` across the thread boundary, so derives `features` itself).
export function featuresForFile(features: Feature[], cfg: Config, file: FileStat): Feature[] {
  return features.filter((feature) => !feature.enabledForFile || feature.enabledForFile(cfg, file));
}

function reparseSerial(files: FileStat[], features: Feature[], cfg: Config, onParsed?: (done: number) => void): FileResult[] {
  const results: FileResult[] = [];
  let done = 0;
  for (const file of files) {
    const fileFeatures = featuresForFile(features, cfg, file);
    results.push(parseFile(file, fileFeatures, cfg));
    onParsed?.(++done);
  }
  return results;
}

// Dispatches through `pool` when the caller owns one (a builder, kept alive across calls); with
// none given, opens an ephemeral ParsePool for this call alone and always closes it.
async function reparsePooled(files: FileStat[], features: Feature[], cfg: Config, onParsed: ((done: number) => void) | undefined, maxWorkers: number, pool: ParsePool | undefined): Promise<FileResult[]> {
  if (pool) return pool.run(files, features, cfg, onParsed, maxWorkers);
  const ephemeral = new ParsePool();
  let results: FileResult[] | undefined;
  let dispatchError: unknown;
  let dispatchFailed = false;
  try {
    results = await ephemeral.run(files, features, cfg, onParsed, maxWorkers);
  } catch (err) {
    dispatchFailed = true;
    dispatchError = err;
  }
  try {
    await ephemeral.close();
  } catch (closeError) {
    if (dispatchFailed) throw new AggregateError([dispatchError, closeError], 'parse dispatch and pool close failed');
    throw closeError;
  }
  if (dispatchFailed) throw dispatchError;
  if (results === undefined) throw new Error('parse dispatch finished without results');
  return results;
}

function parseWorkerCount(files: FileStat[], bytesPerWorker: number, maxWorkers: number): number {
  if (files.length === 0) return 0;
  const available = Math.max(1, Math.min(maxWorkers, files.length));
  if (bytesPerWorker === 0) return available;
  let totalBytes = 0;
  let largestBytes = 0;
  for (const file of files) {
    totalBytes += file.size;
    largestBytes = Math.max(largestBytes, file.size);
  }
  const aggregateWorkers = Math.floor(totalBytes / bytesPerWorker);
  // The largest file is indivisible, so extra workers need full shares among the remainder.
  const companionWorkers = 1 + Math.floor((totalBytes - largestBytes) / bytesPerWorker);
  return Math.min(available, aggregateWorkers, companionWorkers);
}

// `onParsed` receives the running count (1-based) after each file, mirroring a Progress.tick
// call; pass one in to keep progress reporting working without this module owning a reporter.
export async function reparseFiles(files: FileStat[], features: Feature[], cfg: Config, knownColumns: ReadonlySet<string>, onParsed?: (done: number) => void, options: ReparseOptions = {}): Promise<ReparseResult> {
  const threshold = options.threshold ?? PARSE_BYTES_PER_WORKER;
  const maxWorkers = options.maxWorkers ?? Math.min(DEFAULT_MAX_WORKERS, availableParallelism());
  const workerCount = parseWorkerCount(files, threshold, maxWorkers);
  const pooled = files.length > 0 && (threshold === 0 || workerCount >= 2);
  const results = pooled ? await reparsePooled(files, features, cfg, onParsed, workerCount, options.pool) : reparseSerial(files, features, cfg, onParsed);

  const docs: ParsedDoc[] = [];
  const warnings: string[] = [];
  const newColumns: string[] = [];
  const seen = new Set(knownColumns);
  let workerParseMs = 0;
  for (const { doc, warnings: fileWarnings, parseMs } of results) {
    warnings.push(...fileWarnings);
    workerParseMs += parseMs ?? 0;
    for (const key of Object.keys(doc.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        newColumns.push(key);
      }
    }
    docs.push(doc);
  }

  return { docs, warnings, newColumns, workerParseMs };
}
