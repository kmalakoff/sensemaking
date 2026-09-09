// Classifies every row a sitting can compare, and rolls the results into PASS/BLOCK. release.mjs
// calls this once per sitting and stores the result; report.mjs only ever reads it back, so a
// re-render never recomputes anything (idempotent by construction).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './classify.mjs';
import { metricRangeError } from './metrics.mjs';
import { ROW_BY_KEY, ROWS, rowValue, TIMING_KINDS } from './rows.mjs';
import { identityHash } from './workload-identity.mjs';

const WALL_INPROC_TOKENS = ROWS.filter((row) => TIMING_KINDS.includes(row.kind));
const QUALITY_ROWS = ROWS.filter((row) => row.kind === 'quality');

/**
 * @typedef {object} Classification
 * @property {string} id
 * @property {string} context
 * @property {string} key
 * @property {string} verdict
 * @property {string} reason
 * @property {unknown} prior
 * @property {unknown} current
 * @property {boolean} [invalid]
 * @property {string} [comparison_class]
 * @property {string} [variant]
 * @property {string} [workload_id]
 * @property {string | null} [prior_workload_id]
 */

// A record: <date>-<version>-release-gate.json. An unreleased sitting's report never lives here.
export const REPORT_JSON_RE = /^(\d{4}-\d{2}-\d{2})-(\d+\.\d+\.\d+)-release-gate\.json$/;

export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// Every record for a release at or before the baseline this sitting measured against, newest
// release first. Ordered by version, not date, so several releases on one day still find each other.
export function findPriorReports(reportsDir, baselineVersion) {
  if (!existsSync(reportsDir) || !baselineVersion) return [];
  return readdirSync(reportsDir)
    .map((name) => {
      const m = REPORT_JSON_RE.exec(name);
      return m ? { name, date: m[1], version: m[2] } : null;
    })
    .filter((c) => c && compareVersions(c.version, baselineVersion) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version) || (a.date < b.date ? 1 : -1))
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

// Newest prior record, for the fields that are genuinely per-report rather than per-step.
export function findPriorReport(reportsDir, baselineVersion) {
  return findPriorReports(reportsDir, baselineVersion)[0]?.report ?? null;
}

const valueError = (record, row) => {
  const named = record?.errors?.[row.key];
  if (named) return typeof named === 'string' ? named : (named.message ?? named.error ?? JSON.stringify(named));
  if (row.key.startsWith('inproc.') && record?.inproc?.error) return String(record.inproc.error);
  return null;
};

const invalidValue = (value) => value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value));

function rowIdentity(record, key, variant = null) {
  if (variant !== null) {
    const data = record?.variants?.[variant];
    const identity = data?.workload_identity;
    if (!identity || typeof identity !== 'object' || typeof identity.fingerprint !== 'string' || identity.fingerprint !== identityHash(identity.inputs)) return null;
    const model = identity.inputs?.requested?.model;
    if (model?.status !== 'not-applicable' && model?.reuse_eligible !== true) return null;
    return identity.fingerprint;
  }
  const row = record?.workload_identity?.logical_inputs?.rows?.[key];
  if (!row || typeof row !== 'object' || typeof row.fingerprint !== 'string' || row.fingerprint !== identityHash(row.inputs)) return null;
  return row.fingerprint;
}

function identityClassification(id, context, row, currentRecord, priorRecord, current, prior, variant = null) {
  const currentId = rowIdentity(currentRecord, row.key, variant);
  const priorId = priorRecord ? rowIdentity(priorRecord, row.key, variant) : null;
  if (!currentId) return failedReading(id, context, row, 'current workload identity is missing or invalid', prior ?? null, current ?? null);
  if (!priorRecord) return { id, context, key: row.key, ...(variant ? { variant } : {}), verdict: 'no-compatible-prior', reason: `${row.label}: no compatible prior recorded`, prior: null, current, workload_id: currentId, prior_workload_id: null };
  if (!priorId || priorId !== currentId) return { id, context, key: row.key, ...(variant ? { variant } : {}), verdict: 'no-compatible-prior', reason: `${row.label}: prior workload identity is missing or differs`, prior: null, current, workload_id: currentId, prior_workload_id: priorId };
  return { workload_id: currentId, prior_workload_id: priorId };
}

/** @template {object} T @param {T & { key: string }} classification @returns {T & { comparison_class?: string }} */
function withRowClass(classification) {
  const rowClass = ROW_BY_KEY.get(classification.key)?.comparison_class;
  return rowClass ? { ...classification, comparison_class: rowClass } : classification;
}

/** @param {Classification[]} classifications @returns {Classification[]} */
function withRowClasses(classifications) {
  return classifications.map(withRowClass);
}

const failedReading = (id, context, row, reason, prior, current) => ({
  id,
  context,
  key: row.key,
  verdict: 'failed',
  invalid: true,
  reason: `${row.label}: ${reason}`,
  prior,
  current,
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasMeasurement = (record) => WALL_INPROC_TOKENS.some((row) => rowValue(record, row.key) !== null && rowValue(record, row.key) !== undefined) || WALL_INPROC_TOKENS.some((row) => valueError(record, row));

// compare.mjs's JSON: baseline is prior, local is current, gated on row.band; reversedJson confirms
// a row beyond band. A null current with an `errors` entry is a failed measurement, not an absence.
/** @returns {Classification[]} */
export function classifyCompare(compareJson, reversedJson, { requireIdentity = false } = {}) {
  const versions = compareJson?.versions;
  const validVersions = Array.isArray(versions) && versions.length === 2 && versions.every((version) => typeof version === 'string' && version.length > 0) && versions[0] !== versions[1];
  const reversedVersions = reversedJson?.versions;
  const validReversedVersions =
    !reversedJson || (Array.isArray(reversedVersions) && reversedVersions.length === 2 && reversedVersions.every((version) => typeof version === 'string' && version.length > 0) && reversedVersions[0] !== reversedVersions[1] && reversedVersions[0] === versions?.[0] && reversedVersions[1] === versions?.[1]);
  if (
    !validVersions ||
    !validReversedVersions ||
    !isRecord(compareJson?.results) ||
    !isRecord(compareJson.results[versions[0]]) ||
    !isRecord(compareJson.results[versions[1]]) ||
    (reversedJson && (!isRecord(reversedJson.results) || !isRecord(reversedJson.results[versions[0]]) || !isRecord(reversedJson.results[versions[1]])))
  ) {
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: `compare artifact is incomplete${compareJson?.error ? `: ${compareJson.error}` : ''}`, prior: null, current: null }];
  }
  if (compareJson.error || reversedJson?.error || (typeof compareJson.errors === 'number' && compareJson.errors > 0) || (typeof reversedJson?.errors === 'number' && reversedJson.errors > 0)) {
    const error = compareJson.error ?? reversedJson?.error ?? `error count ${compareJson.errors ?? reversedJson.errors}`;
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: `compare artifact is invalid: ${error}`, prior: null, current: null }];
  }
  const [baseline, local] = versions;
  const localResult = compareJson.results[local];
  if (!hasMeasurement(localResult) || (reversedJson && !hasMeasurement(reversedJson.results[local]))) {
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: 'compare artifact contains no current measurement readings or named errors', prior: null, current: null }];
  }
  const out = [];
  for (const row of WALL_INPROC_TOKENS) {
    const current = rowValue(localResult, row.key);
    const prior = rowValue(compareJson.results[baseline], row.key);
    const currentError = valueError(localResult, row);
    const priorError = valueError(compareJson.results[baseline], row);
    const reversedError = reversedJson && (valueError(reversedJson.results?.[local], row) ?? valueError(reversedJson.results?.[baseline], row));
    const reversedCurrent = reversedJson ? rowValue(reversedJson.results?.[local], row.key) : null;
    const reversedPrior = reversedJson ? rowValue(reversedJson.results?.[baseline], row.key) : null;
    if (currentError) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, `working tree measurement failed: ${currentError}`, prior, current ?? null));
      continue;
    }
    if (priorError) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, `prior measurement is invalid: ${priorError}`, prior, current ?? null));
      continue;
    }
    if (reversedError) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, `reversed measurement is invalid: ${reversedError}`, prior, current ?? null));
      continue;
    }
    if (invalidValue(reversedCurrent) || invalidValue(reversedPrior)) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, 'reversed measurement is non-finite', prior, current));
      continue;
    }
    if (invalidValue(current)) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, 'working tree measurement is non-finite', prior, current));
      continue;
    }
    if (invalidValue(prior)) {
      out.push(failedReading(`compare/${row.key}`, 'compare', row, 'prior measurement is non-finite', prior, current));
      continue;
    }
    if (current === null || current === undefined) {
      continue;
    }
    const identity = requireIdentity ? identityClassification(`compare/${row.key}`, 'compare', row, localResult, compareJson.results[baseline], current, prior) : null;
    if (identity && 'verdict' in identity) {
      out.push(identity);
      continue;
    }
    if (requireIdentity && reversedJson) {
      const forwardCurrentId = rowIdentity(localResult, row.key);
      const forwardPriorId = rowIdentity(compareJson.results[baseline], row.key);
      if (rowIdentity(reversedJson.results?.[local], row.key) !== forwardCurrentId || rowIdentity(reversedJson.results?.[baseline], row.key) !== forwardPriorId) {
        out.push(failedReading(`compare/${row.key}`, 'compare', row, 'reversed workload identity is missing or differs', prior, current));
        continue;
      }
    }
    const reversed = reversedJson ? { prior: rowValue(reversedJson.results?.[baseline], row.key), current: rowValue(reversedJson.results?.[local], row.key) } : undefined;
    const c = classify(row, prior, current, { reversed, useCross: false });
    out.push({ id: `compare/${row.key}`, context: 'compare', key: row.key, ...c, prior, current, ...(identity ?? {}) });
  }
  return withRowClasses(out);
}

// The gate uses the same identity-aware classification as the report to decide whether a reversed
// timing run is warranted; a workload that cannot be compared must not trigger another measurement.
export function shouldRunReversedCompare(compareJson) {
  return classifyCompare(compareJson, null, { requireIdentity: true }).some((classification) => classification.verdict === 'moved');
}

// Cross-sitting readings sharing one row set: hub/13k/26k feed the consistent-growth rule, while
// stress and each store battery form a lone group gated on the cross band alone.
/** @returns {Classification[]} */
export function classifyCrossGroup(runJsonByStep, priorSteps, { requireIdentity = false } = {}) {
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
      if (requireIdentity) {
        const currentId = rowIdentity(runJsonByStep[stepId], row.key);
        if (!currentId || currentId !== rowIdentity(priorRun, row.key)) continue;
      }
      deltas[row.key] ??= {};
      deltas[row.key][stepId] = (current - prior) / prior;
    }
  }
  const out = [];
  for (const stepId of stepIds) {
    const runJson = runJsonByStep[stepId];
    if (runJson?.error || (typeof runJson?.errors === 'number' && runJson.errors > 0) || !runJson || typeof runJson !== 'object') {
      const error = runJson?.error ?? (typeof runJson?.errors === 'number' ? `error count ${runJson.errors}` : null);
      out.push({ id: `${stepId}/validity`, context: stepId, key: 'validity', verdict: 'failed', invalid: true, reason: `${stepId}: artifact is incomplete${error ? `: ${error}` : ''}`, prior: null, current: null });
      continue;
    }
    const hasReadings = WALL_INPROC_TOKENS.some((row) => rowValue(runJson, row.key) !== null && rowValue(runJson, row.key) !== undefined) || WALL_INPROC_TOKENS.some((row) => runJson.errors?.[row.key]) || Boolean(runJson.inproc?.error);
    if (!hasReadings) {
      out.push({ id: `${stepId}/validity`, context: stepId, key: 'validity', verdict: 'failed', invalid: true, reason: `${stepId}: artifact contains no measurement readings or named errors`, prior: null, current: null });
      continue;
    }
    const priorRun = priorSteps?.[stepId] ?? null;
    for (const row of WALL_INPROC_TOKENS) {
      const current = rowValue(runJson, row.key);
      const prior = priorRun ? rowValue(priorRun, row.key) : null;
      const currentError = valueError(runJson, row);
      const priorError = valueError(priorRun, row);
      if (currentError) {
        out.push(failedReading(`${stepId}/${row.key}`, stepId, row, `working tree measurement failed: ${currentError}`, prior, current ?? null));
        continue;
      }
      if (priorError) {
        out.push(failedReading(`${stepId}/${row.key}`, stepId, row, `prior measurement is invalid: ${priorError}`, prior, current ?? null));
        continue;
      }
      if (invalidValue(current)) {
        out.push(failedReading(`${stepId}/${row.key}`, stepId, row, 'working tree measurement is non-finite', prior, current));
        continue;
      }
      if (invalidValue(prior)) {
        out.push(failedReading(`${stepId}/${row.key}`, stepId, row, 'prior measurement is non-finite', prior, current));
        continue;
      }
      if (current === null || current === undefined) {
        continue;
      }
      const identity = requireIdentity ? identityClassification(`${stepId}/${row.key}`, stepId, row, runJson, priorRun, current, prior) : null;
      if (identity && 'verdict' in identity) {
        out.push(identity);
        continue;
      }
      const sizeDeltas =
        row.kind === 'tokens'
          ? []
          : Object.entries(deltas[row.key] ?? {})
              .filter(([id]) => id !== stepId)
              .map(([, d]) => d);
      const c = classify(row, prior, current, { useCross: true, sizeDeltas });
      out.push({ id: `${stepId}/${row.key}`, context: stepId, key: row.key, ...c, prior, current, ...(identity ?? {}) });
    }
  }
  return withRowClasses(out);
}

// One eval.mjs-shaped JSON (nfcorpus or fever): one classification per variant per quality row.
// retrievalOwed decides which branch of the quality rule applies (see classify.mjs).
/** @returns {Classification[]} */
export function classifyEval(stepId, evalJson, priorEvalJson, retrievalOwed, { requireIdentity = false } = {}) {
  const out = [];
  const variants = Object.entries(evalJson?.variants ?? {});
  const evalErrors = Number(evalJson?.errors ?? 0);
  const evalErrorsMalformed = evalJson?.errors !== undefined && (!Number.isFinite(evalErrors) || evalErrors < 0);
  if (!evalJson || evalJson.error || evalJson.incomplete === true || evalErrors > 0 || evalErrorsMalformed || variants.length === 0) {
    const reason = evalJson?.error ?? (evalErrors > 0 ? `${evalErrors} retrieval error(s)` : `${stepId}: artifact is incomplete`);
    out.push({ id: `${stepId}/validity`, context: stepId, key: 'validity', verdict: 'failed', invalid: true, reason, prior: null, current: null });
    return out;
  }
  for (const [variantName, rawVariantData] of variants) {
    const variantData = rawVariantData && typeof rawVariantData === 'object' ? rawVariantData : {};
    const priorVariants = priorEvalJson?.variants;
    const hasPriorVariant = priorVariants !== null && typeof priorVariants === 'object' && !Array.isArray(priorVariants) && Object.hasOwn(priorVariants, variantName);
    const rawPriorVariant = hasPriorVariant ? priorVariants[variantName] : undefined;
    const priorVariantMalformed = hasPriorVariant && (rawPriorVariant === null || typeof rawPriorVariant !== 'object' || Array.isArray(rawPriorVariant));
    const priorVariant = priorVariantMalformed ? null : rawPriorVariant;
    const validityId = `${stepId}/${variantName}/validity`;
    const errors = Number(variantData.errors ?? 0);
    const errorDetails = variantData.error_details ?? variantData.errors_detail;
    const detail = Array.isArray(errorDetails) && errorDetails.length > 0 ? ` (${errorDetails.map((e) => `${e.qid ?? 'unknown qid'}: ${e.error ?? e}`).join('; ')})` : '';
    const errorsMalformed = variantData.errors !== undefined && (!Number.isFinite(errors) || errors < 0);
    const currentMissing = QUALITY_ROWS.filter((row) => variantData[row.key] === null || variantData[row.key] === undefined);
    const currentNonFinite = QUALITY_ROWS.filter((row) => invalidValue(variantData[row.key]));
    const currentOutOfRange = QUALITY_ROWS.filter((row) => !currentMissing.includes(row) && !currentNonFinite.includes(row) && metricRangeError(row.key, variantData[row.key]));
    let invalidVariant = false;
    if (errors > 0 || errorsMalformed || variantData.incomplete === true || currentMissing.length > 0 || currentNonFinite.length > 0 || currentOutOfRange.length > 0) {
      const reason = errors > 0 ? `${errors} retrieval error(s)${detail}` : `incomplete artifact${detail}`;
      const missing = currentMissing.map((row) => row.key).join(', ');
      const nonFinite = currentNonFinite.map((row) => row.key).join(', ');
      const outOfRange = currentOutOfRange.map((row) => `${row.key} (${metricRangeError(row.key, variantData[row.key])})`).join(', ');
      const suffix = [missing && `missing metric(s): ${missing}`, nonFinite && `non-finite metric(s): ${nonFinite}`, outOfRange && `out-of-range metric(s): ${outOfRange}`].filter(Boolean).join('; ');
      out.push({ id: validityId, context: `${stepId}/${variantName}`, key: 'validity', variant: variantName, verdict: 'failed', invalid: true, reason: `${variantName}: ${reason}`, prior: null, current: null });
      if (suffix) out[out.length - 1].reason += `; ${suffix}`;
      invalidVariant = true;
    }
    const priorErrors = Number(priorVariant?.errors ?? 0);
    const priorErrorsMalformed = priorVariant?.errors !== undefined && (!Number.isFinite(priorErrors) || priorErrors < 0);
    const priorMissing = priorVariant && QUALITY_ROWS.some((row) => priorVariant[row.key] === null || priorVariant[row.key] === undefined);
    const priorNonFinite = priorVariant && QUALITY_ROWS.some((row) => invalidValue(priorVariant[row.key]));
    const priorOutOfRange = priorVariant && QUALITY_ROWS.some((row) => row.key in priorVariant && !invalidValue(priorVariant[row.key]) && metricRangeError(row.key, priorVariant[row.key]));
    const priorEvalErrors = Number(priorEvalJson?.errors ?? 0);
    const priorEvalErrorsMalformed = priorEvalJson?.errors !== undefined && (!Number.isFinite(priorEvalErrors) || priorEvalErrors < 0);
    if (priorEvalJson?.error || priorEvalJson?.incomplete === true || priorEvalErrors > 0 || priorEvalErrorsMalformed || priorVariantMalformed || (priorVariant && (priorErrors > 0 || priorErrorsMalformed || priorVariant.incomplete === true || priorMissing || priorNonFinite || priorOutOfRange))) {
      const priorReason = priorEvalJson?.error ?? (priorEvalErrors > 0 ? `${priorEvalErrors} retrieval error(s)` : priorVariantMalformed ? 'malformed variant' : priorNonFinite ? 'non-finite metric' : priorOutOfRange ? 'out-of-range metric' : priorMissing ? 'missing metric' : `${priorErrors} retrieval error(s)`);
      out.push({
        id: validityId,
        context: `${stepId}/${variantName}`,
        key: 'validity',
        variant: variantName,
        verdict: 'failed',
        invalid: true,
        reason: `${variantName}: prior artifact is ${priorNonFinite ? 'non-finite' : priorOutOfRange ? 'out-of-range' : priorMissing ? 'incomplete' : 'invalid'} (${priorReason})`,
        prior: null,
        current: null,
      });
      invalidVariant = true;
    }
    if (invalidVariant) continue;
    for (const row of QUALITY_ROWS) {
      const current = variantData[row.key];
      const prior = priorVariant ? priorVariant[row.key] : null;
      const identity = requireIdentity ? identityClassification(`${stepId}/${variantName}/${row.key}`, `${stepId}/${variantName}`, row, evalJson, priorEvalJson, current, prior, variantName) : null;
      if (identity && 'verdict' in identity) {
        out.push(identity);
        continue;
      }
      if (invalidValue(prior)) {
        out.push({ id: `${stepId}/${variantName}/${row.key}`, context: `${stepId}/${variantName}`, key: row.key, variant: variantName, verdict: 'failed', invalid: true, reason: `${row.label}: prior ${variantName} artifact is non-finite`, prior, current });
        continue;
      }
      const c = classify(row, prior, current, { retrievalOwed });
      out.push({ id: `${stepId}/${variantName}/${row.key}`, context: `${stepId}/${variantName}`, key: row.key, variant: variantName, ...c, prior, current, ...(identity ?? {}) });
    }
  }
  return withRowClasses(out);
}

// Same-sitting invariant: a watcher regressed to repeating bulk_change_ms passes a prior/current
// compare, since two equal numbers stay in band. 0.7 (2026-09-07): derivation in PLAN.md 3.63.
const WATCH_SANITY_RATIO = 0.7;
export function classifyWatchSanity(context, runJson) {
  const change = runJson?.bulk_change_ms;
  const watch = runJson?.bulk_watch_ms;
  if (typeof change !== 'number' || typeof watch !== 'number' || change === 0) return null;
  const ratio = watch / change;
  if (ratio <= WATCH_SANITY_RATIO) return null;
  const label = ROW_BY_KEY.get('bulk_watch_ms').label;
  const reason = `${label}: ${watch}ms is ${(ratio * 100).toFixed(1)}% of bulk_change_ms's ${change}ms on ${context}, at or above the ${(WATCH_SANITY_RATIO * 100).toFixed(0)}% sanity ratio -- the watcher path is not separating from the unwatched reparse`;
  return withRowClass({ id: `${context}/bulk_watch_ms-sanity`, context, key: 'bulk_watch_ms', verdict: 'failed', observation: 'diagnostic', reason, prior: null, current: watch });
}

// One classification per store/size whose run.mjs JSON carries both bulk rows, keyed the same way
// classifyCrossGroup's caller already groups them (hub, scale-13k, battery-duckdb-hub, ...).
export function watchSanityGroup(runJsonById) {
  const out = [];
  for (const [id, runJson] of Object.entries(runJsonById)) {
    const c = classifyWatchSanity(id, runJson);
    if (c) out.push(c);
  }
  return out;
}

// A raw row verdict describes the observation. Release severity is a separate decision: timing,
// quality, and output observations warn unless the artifact names an explicit requirement.
export function classificationSeverity(classification) {
  if (classification.invalid === true) return 'BLOCK';
  const observed = !['flat', 'noise', 'no-prior', 'no-compatible-prior'].includes(classification.verdict);
  if (classification.semantic_change === 'unexplained') return 'BLOCK';
  if (observed && (classification.release_requirement === 'block' || classification.required === true)) return 'BLOCK';
  if (observed && classification.observation === 'diagnostic') return 'WARN';
  if (observed && /proxied|no dedicated spread|no spread of its own/.test(ROW_BY_KEY.get(classification.key)?.source ?? '')) return 'INFO';
  if (observed) return 'WARN';
  return 'INFO';
}

export function withSeverity(classifications) {
  return classifications.map((classification) => ({ ...classification, severity: classificationSeverity(classification) }));
}

// BLOCK reasons come only from invalid or explicitly required evidence. Historical timing,
// relevance, and output observations remain in the report as warnings.
export function aggregateVerdict(classifications, failedStageReasons, accepted = {}) {
  // An owner decision is evidence-specific. It never makes an invalid reading comparable.
  const blocking = classifications.filter((c) => classificationSeverity(c) === 'BLOCK' && (!accepted[c.id]?.reason || c.invalid));
  const reasons = [...failedStageReasons, ...blocking.map((c) => c.reason)];
  return { verdict: reasons.length > 0 ? 'BLOCK' : 'PASS', reasons };
}
