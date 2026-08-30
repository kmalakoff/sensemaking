import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
// Type-only: erased at build, but keeps depcheck's usage check satisfied for the tier-2
// `_require` below (see coding-standards' deferral tiers).
import type * as TinypoolNS from 'tinypool';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import type { ParseTask, ParseTaskResult, ParseWorkerData } from '../workers/parse.ts';
import type { ParsedDoc } from './index.ts';
import { parseFile } from './index.ts';
import type { FileStat } from './list.ts';
import { reviveError } from './worker-error.ts';

// Tinypool is ESM-only; our floor (>=22.20) has native require(esm), so the tier-2 house deferral reaches it.
// Deferred (not top-level) because most reconciles stay below DEFAULT_THRESHOLD and shouldn't pay for pool machinery they never use.
const _require = typeof require === 'undefined' ? createRequire(import.meta.url) : require;

// Store-agnostic per-file parse pass shared by every store's reconcile(). Index-preserving:
// one pass over `files`, pushed in order.
export interface ReparseResult {
  docs: ParsedDoc[];
  warnings: string[];
  // Frontmatter keys not in `knownColumns`, first-seen order -- the order callers ALTER TABLE ADD COLUMN in.
  newColumns: string[];
}

export interface ReparseOptions {
  // Overrides DEFAULT_THRESHOLD below, so tests can force either dispatch mode without
  // needing thousands of fixture files. Internal: no caller in src/ passes it.
  threshold?: number;
  // Overrides DEFAULT_MAX_WORKERS below.
  maxWorkers?: number;
}

// Measured 2026-08-29 on a 14-core Apple M4 Pro: serial and pooled cross between 160-180 files
// (pool fixed cost ~85-100ms), so 200 keeps margin. 8 workers ties 10 in a 6,566-file sweep; 12+ trends worse.
const DEFAULT_THRESHOLD = 200;
const DEFAULT_MAX_WORKERS = 8;

// Worker MUST load from dist/cjs/: a worker_threads thread is a fresh realm with no inherited
// TS loader hook, so a source path cannot work. Resolved on first pooled dispatch, not at import.
let workerFile: string | undefined;
function resolveWorkerFile(): string {
  if (workerFile) return workerFile;
  const load = createRequire(import.meta.url);
  for (const rel of ['..', '../..', '../../..']) {
    try {
      if ((load(`${rel}/package.json`) as { name?: string }).name === 'sensemaking') {
        workerFile = join(dirname(load.resolve(`${rel}/package.json`)), 'dist', 'cjs', 'workers', 'parse.js');
        return workerFile;
      }
    } catch {}
  }
  throw new Error('cannot locate the sensemaking package root, so the parse worker cannot be found; run npm run build');
}

type FileResult = { doc: ParsedDoc; warnings: string[] };

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

// Never the tree: a worker task carries one FileStat and returns only what parseFile returns --
// extracted text and feature values. Pool created once here, destroyed once dispatch finishes.
async function reparsePooled(files: FileStat[], features: Feature[], cfg: Config, onParsed: ((done: number) => void) | undefined, maxWorkers: number): Promise<FileResult[]> {
  const { Tinypool } = _require('tinypool') as typeof TinypoolNS;
  // cfg and the feature selection are constant for the dispatch, so they cross once per worker
  // as workerData. Features carry closures and cannot cross at all; only their names do.
  const workerData: ParseWorkerData = { cfg, featureNames: features.map((feature) => feature.name) };
  const pool = new Tinypool({ filename: resolveWorkerFile(), minThreads: maxWorkers, maxThreads: maxWorkers, workerData });
  let done = 0;
  try {
    // Promise.all over a mapped array is load-bearing: the resolved array keeps `files` order
    // regardless of task completion order, which first-seen column order depends on downstream.
    const results = await Promise.all(
      files.map(async (file): Promise<FileResult> => {
        const result = (await pool.run(file as ParseTask)) as ParseTaskResult;
        if (!result.ok) throw reviveError(result.error);
        onParsed?.(++done);
        return { doc: result.doc, warnings: result.warnings };
      })
    );
    await pool.destroy();
    return results;
  } catch (err) {
    // Tear the pool down before rethrowing, but a destroy failure must not mask the parse
    // failure that caused it -- not a `finally`, for that reason.
    await pool.destroy().catch(() => {});
    throw err;
  }
}

// `onParsed` receives the running count (1-based) after each file, mirroring a Progress.tick
// call; pass one in to keep progress reporting working without this module owning a reporter.
export async function reparseFiles(files: FileStat[], features: Feature[], cfg: Config, knownColumns: ReadonlySet<string>, onParsed?: (done: number) => void, options: ReparseOptions = {}): Promise<ReparseResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const maxWorkers = options.maxWorkers ?? Math.min(DEFAULT_MAX_WORKERS, availableParallelism());
  const results = files.length >= threshold ? await reparsePooled(files, features, cfg, onParsed, maxWorkers) : reparseSerial(files, features, cfg, onParsed);

  const docs: ParsedDoc[] = [];
  const warnings: string[] = [];
  const newColumns: string[] = [];
  const seen = new Set(knownColumns);
  for (const { doc, warnings: fileWarnings } of results) {
    warnings.push(...fileWarnings);
    for (const key of Object.keys(doc.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        newColumns.push(key);
      }
    }
    docs.push(doc);
  }

  return { docs, warnings, newColumns };
}
