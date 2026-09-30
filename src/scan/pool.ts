import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
// Type-only: erased at build, but keeps depcheck's usage check satisfied for the tier-2
// `_require` below (see coding-standards' deferral tiers).
import type * as TinypoolNS from 'tinypool';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import { resolveWorkerFile } from '../lib/worker-file.ts';
import type { ParsedDoc } from '../scan/index.ts';
import type { ParseTaskResult, ParseWorkerData } from '../workers/parse.ts';
import type { FileStat } from './list.ts';
import { reviveError } from './worker-error.ts';

// Tinypool is ESM-only; our floor (>=22.20) has native require(esm), so the tier-2 house deferral reaches it.
const _require = typeof require === 'undefined' ? createRequire(import.meta.url) : require;
// Candidate queue depth gives uneven files more than one scheduling turn per worker.
// The bounded parser comparison decides whether this value ships.
const BATCHES_PER_WORKER = 4;

// parseMs is worker-side only (see workers/parse.ts); absent on the serial path.
export type FileResult = { doc: ParsedDoc; warnings: string[]; parseMs?: number };

// Created lazily and reused while dispatch context stays equivalent. A builder owns one instance
// for its lifetime instead of paying pool startup for unchanged reconciles.
export class ParsePool {
  private pool: TinypoolNS.Tinypool | undefined;
  private workerData: ParseWorkerData | undefined;
  private workerCount: number | undefined;
  private operation: Promise<void> = Promise.resolve();
  // Tinypools this instance has constructed. Repeated equivalent dispatches leave this unchanged;
  // a context/count change or close followed by run constructs another pool.
  poolsCreated = 0;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async ensure(workerData: ParseWorkerData, workerCount: number): Promise<TinypoolNS.Tinypool> {
    if (this.pool && (!isDeepStrictEqual(this.workerData, workerData) || this.workerCount !== workerCount)) await this.destroy();
    if (!this.pool) {
      const { Tinypool } = _require('tinypool') as typeof TinypoolNS;
      this.pool = new Tinypool({ filename: resolveWorkerFile('parse'), minThreads: workerCount, maxThreads: workerCount, workerData });
      this.workerData = workerData;
      this.workerCount = workerCount;
      this.poolsCreated++;
    }
    return this.pool;
  }

  // Never the tree: a worker task carries a bounded FileStat batch and returns only what
  // parseFile returns for each file, never the token tree.
  run(files: FileStat[], features: Feature[], cfg: Config, onParsed: ((done: number) => void) | undefined, requestedWorkers: number): Promise<FileResult[]> {
    if (files.length === 0) return Promise.resolve([]);
    // Snapshot at invocation so caller mutation cannot change queued work or its reuse baseline.
    const workerData: ParseWorkerData = { cfg: structuredClone(cfg), featureNames: [...new Set(features.map((feature) => feature.name))].sort() };
    const workerCount = Math.max(1, Math.min(requestedWorkers, files.length));
    return this.enqueue(() => this.dispatch(files, workerData, onParsed, workerCount));
  }

  private async dispatch(files: FileStat[], workerData: ParseWorkerData, onParsed: ((done: number) => void) | undefined, workerCount: number): Promise<FileResult[]> {
    const pool = await this.ensure(workerData, workerCount);
    const batches = batchFiles(files, Math.min(files.length, workerCount * BATCHES_PER_WORKER));
    let done = 0;
    const settled = await Promise.all(
      batches.map(async (batch): Promise<{ results: FileResult[]; failures: unknown[] }> => {
        let taskResults: ParseTaskResult;
        try {
          taskResults = (await pool.run(batch)) as ParseTaskResult;
        } catch (err) {
          return { results: [], failures: [err] };
        }

        const results: FileResult[] = [];
        const failures: unknown[] = [];
        for (const result of taskResults) {
          if (!result.ok) {
            failures.push(reviveError(result.error));
            continue;
          }
          results.push({ doc: result.doc, warnings: result.warnings, parseMs: result.parseMs });
          try {
            onParsed?.(++done);
          } catch (err) {
            failures.push(err);
          }
        }
        return { results, failures };
      })
    );
    const results: FileResult[] = [];
    const failures: unknown[] = [];
    for (const batch of settled) {
      results.push(...batch.results);
      failures.push(...batch.failures);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} parse tasks failed`);
    // Promise.all and contiguous batches preserve the input order that first-seen columns use.
    return results;
  }

  private async destroy(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    await pool.destroy();
    this.pool = undefined;
    this.workerData = undefined;
    this.workerCount = undefined;
  }

  // A pool never created costs nothing to destroy. Queuing lets active dispatches drain first.
  close(): Promise<void> {
    return this.enqueue(() => this.destroy());
  }
}

function batchFiles(files: FileStat[], batchCount: number): FileStat[][] {
  const batches: FileStat[][] = [];
  let start = 0;
  let remainingBytes = files.reduce((sum, file) => sum + file.size, 0);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const remainingBatches = batchCount - batchIndex;
    if (remainingBatches === 1) {
      batches.push(files.slice(start));
      break;
    }

    const targetBytes = remainingBytes / remainingBatches;
    const lastEnd = files.length - (remainingBatches - 1);
    let end = start;
    let bytes = 0;
    while (end < lastEnd && (end === start || bytes < targetBytes)) {
      bytes += files[end].size;
      end++;
    }
    batches.push(files.slice(start, end));
    start = end;
    remainingBytes -= bytes;
  }
  return batches;
}
