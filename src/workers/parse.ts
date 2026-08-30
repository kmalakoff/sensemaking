import Tinypool from 'tinypool';
import type { Config, FeatureName } from '../config/index.ts';
import { FEATURES } from '../features/index.ts';
import type { ParsedDoc } from '../scan/index.ts';
import { parseFile } from '../scan/index.ts';
import type { FileStat } from '../scan/list.ts';
import { featuresForFile } from '../scan/reparse.ts';
import type { WorkerErrorPayload } from '../scan/worker-error.ts';
import { serializeError } from '../scan/worker-error.ts';

// Constant for the whole dispatch, so it crosses once per worker instead of once per task. A
// Feature carries closures and cannot cross the thread boundary; its name can, and the registry here resolves it back.
export interface ParseWorkerData {
  cfg: Config;
  featureNames: FeatureName[];
}

// tinypool's task, in and out. The task itself is one FileStat. Result carries only what
// parseFile already returns -- extracted text and per-feature values, never the mdast tree.
export type ParseTask = FileStat;

export type ParseTaskResult = { ok: true; doc: ParsedDoc; warnings: string[] } | { ok: false; error: WorkerErrorPayload };

// Read once per worker, not per task.
const { cfg, featureNames } = Tinypool.workerData as ParseWorkerData;
// Filtering the registry (rather than mapping the names) keeps registry order, which is the
// order `extracted` keys land in on the serial path.
const selected = FEATURES.filter((feature) => featureNames.includes(feature.name));

export default function parseTask(file: ParseTask): ParseTaskResult {
  try {
    const { doc, warnings } = parseFile(file, featuresForFile(selected, cfg, file), cfg);
    return { ok: true, doc, warnings };
  } catch (err) {
    return { ok: false, error: serializeError(err) };
  }
}
