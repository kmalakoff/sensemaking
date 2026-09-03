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
  // Overrides DEFAULT_THRESHOLD below, so tests can force either dispatch mode without
  // needing thousands of fixture files. Internal: no caller in src/ passes it.
  threshold?: number;
  // Overrides DEFAULT_MAX_WORKERS below.
  maxWorkers?: number;
  // A builder-owned pool to dispatch through instead of creating and destroying one for this
  // call alone (see store/builder.ts). Absent, reparseFiles manages its own ephemeral pool.
  pool?: ParsePool;
}

// Measured 2026-08-29 on a 14-core Apple M4 Pro: serial and pooled cross between 160-180 files
// (pool fixed cost ~85-100ms), so 200 keeps margin. 8 workers ties 10 in a 6,566-file sweep; 12+ trends worse.
const DEFAULT_THRESHOLD = 200;
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
  try {
    const results = await ephemeral.run(files, features, cfg, onParsed, maxWorkers);
    await ephemeral.close();
    return results;
  } catch (err) {
    // Tear the pool down before rethrowing, but a close failure must not mask the parse
    // failure that caused it -- not a `finally`, for that reason.
    await ephemeral.close().catch(() => {});
    throw err;
  }
}

// `onParsed` receives the running count (1-based) after each file, mirroring a Progress.tick
// call; pass one in to keep progress reporting working without this module owning a reporter.
export async function reparseFiles(files: FileStat[], features: Feature[], cfg: Config, knownColumns: ReadonlySet<string>, onParsed?: (done: number) => void, options: ReparseOptions = {}): Promise<ReparseResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxWorkers = options.maxWorkers ?? Math.min(DEFAULT_MAX_WORKERS, availableParallelism());
  const results = files.length >= threshold ? await reparsePooled(files, features, cfg, onParsed, maxWorkers, options.pool) : reparseSerial(files, features, cfg, onParsed);

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
