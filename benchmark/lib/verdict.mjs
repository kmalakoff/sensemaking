// Classifies every row a sitting can compare, and rolls the results into PASS/BLOCK. release.mjs
// calls this once per sitting and stores the result; report.mjs only ever reads it back, so a
// re-render never recomputes anything (idempotent by construction).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_VERDICTS, classify } from './classify.mjs';
import { ROWS, rowValue, TIMING_KINDS } from './rows.mjs';

const WALL_INPROC_TOKENS = ROWS.filter((row) => TIMING_KINDS.includes(row.kind));
const QUALITY_ROWS = ROWS.filter((row) => row.kind === 'quality');

// A record: <date>-<version>-release-gate.json. An unreleased sitting's report never lives here.
export const REPORT_JSON_RE = /^(\d{4}-\d{2}-\d{2})-\d+\.\d+\.\d+-release-gate\.json$/;

// Every earlier release-gate JSON, newest first. Plural because the prior resolves per step: one
// report for the whole run lets a sitting that skipped a step blind the next sitting that runs it.
export function findPriorReports(reportsDir, excludeDate) {
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir)
    .map((name) => ({ name, date: REPORT_JSON_RE.exec(name)?.[1] }))
    .filter((c) => c.date && c.date < excludeDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((c) => ({ ...c, report: JSON.parse(readFileSync(join(reportsDir, c.name), 'utf8')) }));
}

// stepId -> { step, from } from the newest earlier report carrying that step at currentVersion;
// { step: null, from, mismatch } when only another harness version has it; null when none does.
export function priorStepLookup(priorReports, currentVersion) {
  return (stepId) => {
    let mismatch = null;
    for (const { name, report } of priorReports) {
      const step = report.steps?.[stepId];
      if (!step) continue;
      const version = step.measure_version ?? 'm2'; // unstamped: the 2026-09-02 report predates the stamp, measured by m2
      if (version === currentVersion) return { step, from: name };
      mismatch ??= { step: null, from: name, mismatch: { prior: version, current: currentVersion } };
    }
    return mismatch;
  };
}

// Newest earlier report, for the fields that are genuinely per-report rather than per-step.
export function findPriorReport(reportsDir, excludeDate) {
  return findPriorReports(reportsDir, excludeDate)[0]?.report ?? null;
}

// compare.mjs's JSON: baseline is prior, local is current, gated on row.band; reversedJson confirms
// a row beyond band. A null current with an `errors` entry is a failed measurement, not an absence.
export function classifyCompare(compareJson, reversedJson) {
  const [baseline, local] = compareJson.versions;
  const localResult = compareJson.results[local];
  const out = [];
  for (const row of WALL_INPROC_TOKENS) {
    const current = rowValue(localResult, row.key);
    const prior = rowValue(compareJson.results[baseline], row.key);
    if (current === null || current === undefined) {
      const error = localResult?.errors?.[row.key];
      if (error) out.push({ id: `compare/${row.key}`, context: 'compare', key: row.key, verdict: 'failed', reason: `${row.label}: command failed on the working tree, ${error}`, prior, current: null });
      continue;
    }
    const reversed = reversedJson ? { prior: rowValue(reversedJson.results[baseline], row.key), current: rowValue(reversedJson.results[local], row.key) } : undefined;
    const c = classify(row, prior, current, { reversed, useCross: false });
    out.push({ id: `compare/${row.key}`, context: 'compare', key: row.key, ...c, prior, current });
  }
  return out;
}

// Cross-sitting readings sharing one row set: hub/13k/26k feed the consistent-growth rule, while
// stress and each store battery form a lone group gated on the cross band alone.
export function classifyCrossGroup(runJsonByStep, priorSteps) {
  const stepIds = Object.keys(runJsonByStep);
  const deltas = {};
  for (const stepId of stepIds) {
    const priorRun = priorSteps?.[stepId];
    if (!priorRun) continue;
    for (const row of WALL_INPROC_TOKENS) {
      if (row.kind === 'tokens') continue;
      const current = rowValue(runJsonByStep[stepId], row.key);
      const prior = rowValue(priorRun, row.key);
      if (current == null || prior == null || prior === 0) continue;
      deltas[row.key] ??= {};
      deltas[row.key][stepId] = (current - prior) / prior;
    }
  }
  const out = [];
  for (const stepId of stepIds) {
    const runJson = runJsonByStep[stepId];
    const priorRun = priorSteps?.[stepId] ?? null;
    for (const row of WALL_INPROC_TOKENS) {
      const current = rowValue(runJson, row.key);
      const prior = priorRun ? rowValue(priorRun, row.key) : null;
      if (current === null || current === undefined) {
        const error = runJson?.errors?.[row.key];
        if (error) out.push({ id: `${stepId}/${row.key}`, context: stepId, key: row.key, verdict: 'failed', reason: `${row.label}: command failed on the working tree, ${error}`, prior, current: null });
        continue;
      }
      const sizeDeltas =
        row.kind === 'tokens'
          ? []
          : Object.entries(deltas[row.key] ?? {})
              .filter(([id]) => id !== stepId)
              .map(([, d]) => d);
      const c = classify(row, prior, current, { useCross: true, sizeDeltas });
      out.push({ id: `${stepId}/${row.key}`, context: stepId, key: row.key, ...c, prior, current });
    }
  }
  return out;
}

// One eval.mjs-shaped JSON (nfcorpus or fever): one classification per variant per quality row.
// retrievalOwed decides which branch of the quality rule applies (see classify.mjs).
export function classifyEval(stepId, evalJson, priorEvalJson, retrievalOwed) {
  const out = [];
  for (const [variantName, variantData] of Object.entries(evalJson.variants ?? {})) {
    const priorVariant = priorEvalJson?.variants?.[variantName];
    for (const row of QUALITY_ROWS) {
      const current = variantData[row.key];
      if (current === null || current === undefined) continue;
      const prior = priorVariant ? priorVariant[row.key] : null;
      const c = classify(row, prior, current, { retrievalOwed });
      out.push({ id: `${stepId}/${variantName}/${row.key}`, context: `${stepId}/${variantName}`, key: row.key, variant: variantName, ...c, prior, current });
    }
  }
  return out;
}

// BLOCK reasons in the plan's order: failed stage, token contract, scale/stress, quality, timing.
// An accepted row leaves the reasons list but stays in classifications, shown beside its override.
export function aggregateVerdict(classifications, failedStageReasons, accepted = {}) {
  const blocking = classifications.filter((c) => BLOCK_VERDICTS.has(c.verdict) && !accepted[c.id]?.reason);
  const failed = blocking.filter((c) => c.verdict === 'failed');
  const contracts = blocking.filter((c) => c.verdict === 'contract');
  const quality = blocking.filter((c) => c.verdict !== 'failed' && c.context.startsWith('eval-'));
  const timing = blocking.filter((c) => c.verdict !== 'failed' && c.context === 'compare' && c.verdict !== 'contract');
  const scaleStress = blocking.filter((c) => !failed.includes(c) && !contracts.includes(c) && !quality.includes(c) && !timing.includes(c));
  const reasons = [...failedStageReasons, ...failed.map((c) => c.reason), ...contracts.map((c) => c.reason), ...scaleStress.map((c) => c.reason), ...quality.map((c) => c.reason), ...timing.map((c) => c.reason)];
  return { verdict: reasons.length > 0 ? 'BLOCK' : 'PASS', reasons };
}
