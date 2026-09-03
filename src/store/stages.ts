// Per-stage wall time for one reconcile, all on this thread's clock. Stages name work a build has
// to do, never the function or file doing it, so the vocabulary outlives a pipeline refactor.
export const STAGES_VERSION = 's1';

// Every stage outside the feature hooks, in execution order. Feature hooks add
// `feature:<name>:<hook>` keys, so a new feature becomes visible without touching this list.
export const FIXED_STAGES = ['list', 'existing', 'parse', 'alter', 'added-recheck', 'fm-upsert', 'text-index', 'presets', 'vanished', 'meta'] as const;

export const FEATURE_HOOKS = ['remove', 'store', 'after'] as const;

export type FeatureHook = (typeof FEATURE_HOOKS)[number];

export interface Stages {
  version: string;
  totalMs: number;
  // The write transaction's own duration. It contains most of the spans below, so it is reported
  // beside them rather than among them, and never counts toward the sum.
  txMs: number;
  // Disjoint spans, so `totalMs` less their sum is time no stage claims.
  spans: Record<string, number>;
}

export interface StageRecorder {
  time<T>(stage: string, fn: () => T | Promise<T>): Promise<T>;
  take(totalMs: number, txMs: number): Stages;
}

export function featureStage(name: string, hook: FeatureHook): string {
  return `feature:${name}:${hook}`;
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

// `featureNames` seeds this build's feature-hook keys, so the key set is a function of config
// alone: a cold build (nothing to remove) and an incremental one report the same stages.
export function stageRecorder(featureNames: readonly string[] = []): StageRecorder {
  const spans = new Map<string, number>();
  for (const stage of FIXED_STAGES) spans.set(stage, 0);
  for (const name of featureNames) for (const hook of FEATURE_HOOKS) spans.set(featureStage(name, hook), 0);
  return {
    // A throw records nothing: an aborted reconcile must not report a partial stage as a complete one.
    async time(stage, fn) {
      const at = process.hrtime.bigint();
      const value = await fn();
      spans.set(stage, (spans.get(stage) ?? 0) + Number(process.hrtime.bigint() - at) / 1e6);
      return value;
    },
    // Every declared stage reports, 0 included, so a store that skips some work and a store that
    // does it cheaply read alike across a timeline. An absent `stages` is a build with no timers.
    take(totalMs, txMs) {
      const out: Record<string, number> = {};
      for (const [stage, ms] of spans) out[stage] = round(ms);
      return { version: STAGES_VERSION, totalMs: round(totalMs), txMs: round(txMs), spans: out };
    },
  };
}

// Time no stage claims: transaction commit, lock wait, and any cost added since without a timer.
// A residual that grows across releases is the signal that this vocabulary stopped covering the build.
export function unaccountedMs(stages: Stages): number {
  let sum = 0;
  for (const ms of Object.values(stages.spans)) sum += ms;
  return round(stages.totalMs - sum);
}
