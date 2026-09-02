// Classifies every row a sitting can compare, and rolls the results into PASS/BLOCK. release.mjs
// calls this once per sitting and stores the result; report.mjs only ever reads it back, so a
// re-render never recomputes anything (idempotent by construction).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCK_VERDICTS, classify } from './classify.mjs';
import { ROWS, rowValue, TIMING_KINDS } from './rows.mjs';

const WALL_INPROC_TOKENS = ROWS.filter((row) => TIMING_KINDS.includes(row.kind));
const QUALITY_ROWS = ROWS.filter((row) => row.kind === 'quality');

const REPORT_JSON_RE = /^(\d{4}-\d{2}-\d{2})-release-gate\.json$/;

// Newest earlier release-gate JSON by filename date. null (no-prior for every row) until a
// second sitting has landed a report.
export function findPriorReport(reportsDir, excludeDate) {
  if (!existsSync(reportsDir)) return null;
  const candidates = readdirSync(reportsDir)
    .map((name) => ({ name, date: REPORT_JSON_RE.exec(name)?.[1] }))
    .filter((c) => c.date && c.date < excludeDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return candidates.length > 0 ? JSON.parse(readFileSync(join(reportsDir, candidates[0].name), 'utf8')) : null;
}

// compare.mjs's own JSON: baseline column is prior, local column is current -- a same-sitting
// comparison, gated on row.band. reversedJson (compare.mjs --reverse's output) supplies the
// confirmation reading for a row beyond band.
export function classifyCompare(compareJson, reversedJson) {
  const [baseline, local] = compareJson.versions;
  const out = [];
  for (const row of WALL_INPROC_TOKENS) {
    const current = rowValue(compareJson.results[local], row.key);
    if (current === null || current === undefined) continue;
    const prior = rowValue(compareJson.results[baseline], row.key);
    const reversed = reversedJson ? { prior: rowValue(reversedJson.results[baseline], row.key), current: rowValue(reversedJson.results[local], row.key) } : undefined;
    const c = classify(row, prior, current, { reversed, useCross: false });
    out.push({ id: `compare/${row.key}`, context: 'compare', key: row.key, ...c, prior, current });
  }
  return out;
}

// A group of cross-sitting run.mjs-shaped readings sharing one row set (hub/13k/26k for the
// "consistent, grows with size" rule; a lone group of one for stress or a store battery, which
// gets the cross band with no consistency boost). runJsonByStep: { stepId: parsedRunJson }.
// priorSteps: the same shape read from the prior report's own `steps` (or null).
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
      if (current === null || current === undefined) continue;
      const prior = priorRun ? rowValue(priorRun, row.key) : null;
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

// Plan's stated BLOCK order: the stage that failed; each token contract; each stress/scale row
// beyond band; each quality metric that fell or moved without an owed retrieval change; each
// timing row beyond band whose reversed re-run agreed. `accepted` is the report's own
// { [rowId]: { reason, date } } override map -- an accepted row drops out of the reasons list
// but stays in `classifications` for the report to show beside its override.
export function aggregateVerdict(classifications, failedStageReasons, accepted = {}) {
  const blocking = classifications.filter((c) => BLOCK_VERDICTS.has(c.verdict) && !accepted[c.id]?.reason);
  const contracts = blocking.filter((c) => c.verdict === 'contract');
  const quality = blocking.filter((c) => c.context.startsWith('eval-'));
  const timing = blocking.filter((c) => c.context === 'compare' && c.verdict !== 'contract');
  const scaleStress = blocking.filter((c) => !contracts.includes(c) && !quality.includes(c) && !timing.includes(c));
  const reasons = [...failedStageReasons, ...contracts.map((c) => c.reason), ...scaleStress.map((c) => c.reason), ...quality.map((c) => c.reason), ...timing.map((c) => c.reason)];
  return { verdict: reasons.length > 0 ? 'BLOCK' : 'PASS', reasons };
}
