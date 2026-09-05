import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// Type-only: erased at build, but keeps depcheck's usage check satisfied for the tier-2
// `_require` below (see coding-standards' deferral tiers).
import type * as TinypoolNS from 'tinypool';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import type { ParsedDoc } from '../scan/index.ts';
import type { ParseTask, ParseTaskResult, ParseWorkerData } from '../workers/parse.ts';
import type { FileStat } from './list.ts';
import { reviveError } from './worker-error.ts';

// Tinypool is ESM-only; our floor (>=22.20) has native require(esm), so the tier-2 house deferral reaches it.
const _require = typeof require === 'undefined' ? createRequire(import.meta.url) : require;

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

// parseMs is worker-side only (see workers/parse.ts); absent on the serial path.
export type FileResult = { doc: ParsedDoc; warnings: string[]; parseMs?: number };

// One Tinypool per instance, created lazily on first dispatch and reused by every later call:
// a builder owns one of these for its whole lifetime instead of paying pool startup per reconcile.
export class ParsePool {
  private pool: TinypoolNS.Tinypool | undefined;
  // Tinypools this instance has constructed. One dispatch or a hundred should leave it at 1;
  // it is how a caller, and the specs, observe that a lifetime reuses its pool rather than churning one.
  poolsCreated = 0;

  private ensure(workerData: ParseWorkerData, maxWorkers: number): TinypoolNS.Tinypool {
    if (!this.pool) {
      const { Tinypool } = _require('tinypool') as typeof TinypoolNS;
      this.pool = new Tinypool({ filename: resolveWorkerFile(), minThreads: maxWorkers, maxThreads: maxWorkers, workerData });
      this.poolsCreated++;
    }
    return this.pool;
  }

  // Never the tree: a worker task carries one FileStat and returns only what parseFile returns --
  // extracted text and feature values, never the token tree.
  async run(files: FileStat[], features: Feature[], cfg: Config, onParsed: ((done: number) => void) | undefined, maxWorkers: number): Promise<FileResult[]> {
    // cfg and the feature selection are constant for the dispatch, so they cross once per worker
    // as workerData. Features carry closures and cannot cross at all; only their names do.
    const workerData: ParseWorkerData = { cfg, featureNames: features.map((feature) => feature.name) };
    const pool = this.ensure(workerData, maxWorkers);
    let done = 0;
    // Promise.all over a mapped array is load-bearing: the resolved array keeps `files` order
    // regardless of task completion order, which first-seen column order depends on downstream.
    return Promise.all(
      files.map(async (file): Promise<FileResult> => {
        const result = (await pool.run(file as ParseTask)) as ParseTaskResult;
        if (!result.ok) throw reviveError(result.error);
        onParsed?.(++done);
        return { doc: result.doc, warnings: result.warnings, parseMs: result.parseMs };
      })
    );
  }

  // A pool never created costs nothing to destroy.
  async close(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = undefined;
    await pool.destroy();
  }
}
