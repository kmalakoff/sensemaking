import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
// Type-only: erased at build, but keeps depcheck's usage check satisfied for the tier-2
// `_require` below (see coding-standards' deferral tiers).
import type * as TinypoolNS from 'tinypool';
import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import { resolveWorkerFile } from '../lib/worker-file.ts';
import type { ParsedDoc } from '../scan/index.ts';
import type { ParseTask, ParseTaskResult, ParseWorkerData } from '../workers/parse.ts';
import type { FileStat } from './list.ts';
import { reviveError } from './worker-error.ts';

// Tinypool is ESM-only; our floor (>=22.20) has native require(esm), so the tier-2 house deferral reaches it.
const _require = typeof require === 'undefined' ? createRequire(import.meta.url) : require;

// parseMs is worker-side only (see workers/parse.ts); absent on the serial path.
export type FileResult = { doc: ParsedDoc; warnings: string[]; parseMs?: number };

// Created lazily and reused while dispatch context stays equivalent. A builder owns one instance
// for its lifetime instead of paying pool startup for unchanged reconciles.
export class ParsePool {
  private pool: TinypoolNS.Tinypool | undefined;
  private workerData: ParseWorkerData | undefined;
  private operation: Promise<void> = Promise.resolve();
  // Tinypools this instance has constructed. Repeated equivalent dispatches leave this unchanged;
  // a context change or close followed by run constructs another pool.
  poolsCreated = 0;

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async ensure(workerData: ParseWorkerData, maxWorkers: number): Promise<TinypoolNS.Tinypool> {
    if (this.pool && !isDeepStrictEqual(this.workerData, workerData)) await this.destroy();
    if (!this.pool) {
      const { Tinypool } = _require('tinypool') as typeof TinypoolNS;
      this.pool = new Tinypool({ filename: resolveWorkerFile('parse'), minThreads: maxWorkers, maxThreads: maxWorkers, workerData });
      this.workerData = workerData;
      this.poolsCreated++;
    }
    return this.pool;
  }

  // Never the tree: a worker task carries one FileStat and returns only what parseFile returns --
  // extracted text and feature values, never the token tree.
  run(files: FileStat[], features: Feature[], cfg: Config, onParsed: ((done: number) => void) | undefined, maxWorkers: number): Promise<FileResult[]> {
    // Snapshot at invocation so caller mutation cannot change queued work or its reuse baseline.
    const workerData: ParseWorkerData = { cfg: structuredClone(cfg), featureNames: [...new Set(features.map((feature) => feature.name))].sort() };
    return this.enqueue(() => this.dispatch(files, workerData, onParsed, maxWorkers));
  }

  private async dispatch(files: FileStat[], workerData: ParseWorkerData, onParsed: ((done: number) => void) | undefined, maxWorkers: number): Promise<FileResult[]> {
    const pool = await this.ensure(workerData, maxWorkers);
    let done = 0;
    const settled = await Promise.allSettled(
      files.map(async (file): Promise<FileResult> => {
        const result = (await pool.run(file as ParseTask)) as ParseTaskResult;
        if (!result.ok) throw reviveError(result.error);
        onParsed?.(++done);
        return { doc: result.doc, warnings: result.warnings, parseMs: result.parseMs };
      })
    );
    const results: FileResult[] = [];
    const failures: unknown[] = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') results.push(result.value);
      else failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} parse tasks failed`);
    // allSettled preserves input order, which downstream first-seen column order depends on.
    return results;
  }

  private async destroy(): Promise<void> {
    if (!this.pool) return;
    const pool = this.pool;
    this.pool = undefined;
    this.workerData = undefined;
    await pool.destroy();
  }

  // A pool never created costs nothing to destroy. Queuing lets active dispatches drain first.
  close(): Promise<void> {
    return this.enqueue(() => this.destroy());
  }
}
