// Classifies every row a sitting can compare, and rolls the results into PASS/BLOCK. release.mjs
// calls this once per sitting and stores the result; report.ts only ever reads it back, so a
// re-render never recomputes anything (idempotent by construction).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from './classify.ts';
import { metricRangeError } from './metrics.ts';
import type { Row, RowReading } from './rows.ts';
import { ROW_BY_KEY, ROWS, rowValue, TIMING_KINDS } from './rows.ts';
import { identityHash } from './workload-identity.ts';

const WALL_INPROC_TOKENS = ROWS.filter((row) => TIMING_KINDS.includes(row.kind));
const QUALITY_ROWS = ROWS.filter((row) => row.kind === 'quality');

interface Classification<R = unknown> {
  id: string;
  context: string;
  key: string;
  verdict: string;
  reason: R;
  prior: unknown;
  current: unknown;
  invalid?: boolean;
  comparison_class?: string;
  variant?: string;
  workload_id?: string;
  prior_workload_id?: string | null;
}
interface ReportFile {
  name: string;
  date: string;
  version: string;
}
interface PriorReport {
  name: string;
  report: unknown;
}
interface SeverityInput {
  invalid?: unknown;
  verdict: string;
  semantic_change?: unknown;
  release_requirement?: unknown;
  required?: unknown;
  observation?: unknown;
  key?: string;
}

// A record: <date>-<version>-release-gate.json. An unreleased sitting's report never lives here.
export const REPORT_JSON_RE = /^(\d{4}-\d{2}-\d{2})-(\d+\.\d+\.\d+)-release-gate\.json$/;

export const compareVersions = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// Every record for a release at or before the baseline this sitting measured against, newest
// release first. Ordered by version, not date, so several releases on one day still find each other.
export function findPriorReports(reportsDir: string, baselineVersion: string | null | undefined) {
  if (!existsSync(reportsDir) || !baselineVersion) return [];
  return readdirSync(reportsDir)
    .map((name) => {
      const m = REPORT_JSON_RE.exec(name);
      return m ? { name, date: m[1], version: m[2] } : null;
    })
    .filter((c) => c && compareVersions(c.version, baselineVersion) <= 0)
    .sort((a, b) => compareVersions((b as ReportFile).version, (a as ReportFile).version) || ((a as ReportFile).date < (b as ReportFile).date ? 1 : -1))
    .map((c) => ({ ...(c as ReportFile), report: JSON.parse(readFileSync(join(reportsDir, (c as ReportFile).name), 'utf8')) as unknown }));
}

// stepId -> { step, from } from the newest earlier report carrying that step at currentVersion;
// { step: null, from, mismatch } when only another harness version has it; null when none does.
export function priorStepLookup(priorReports: readonly PriorReport[], currentVersion: string) {
  return (stepId: string) => {
    let mismatch: { step: null; from: string; mismatch: { prior: unknown; current: string } } | null = null;
    for (const { name, report } of priorReports) {
      const step = ((report as { steps?: unknown }).steps as { [key: string]: unknown } | null | undefined)?.[stepId];
      if (!step) continue;
      const version = (step as { measure_version?: unknown }).measure_version ?? 'm2'; // unstamped: the 2026-09-02 report predates the stamp, measured by m2
      if (version === currentVersion) return { step, from: name };
      mismatch ??= { step: null, from: name, mismatch: { prior: version, current: currentVersion } };
    }
    return mismatch;
  };
}

// Newest prior record, for the fields that are genuinely per-report rather than per-step.
export function findPriorReport(reportsDir: string, baselineVersion: string | null | undefined) {
  return findPriorReports(reportsDir, baselineVersion)[0]?.report ?? null;
}

const valueError = (record: unknown, row: RowReading) => {
  const named = ((record as { errors?: unknown } | null | undefined)?.errors as { [key: string]: unknown } | null | undefined)?.[row.key];
  if (named) return typeof named === 'string' ? named : ((named as { message?: unknown }).message ?? (named as { error?: unknown }).error ?? JSON.stringify(named));
  if (row.key.startsWith('inproc.') && ((record as { inproc?: unknown } | null | undefined)?.inproc as { error?: unknown } | null | undefined)?.error) return String(((record as { inproc?: unknown }).inproc as { error?: unknown }).error);
  return null;
};

const invalidValue = (value: unknown) => value !== null && value !== undefined && (typeof value !== 'number' || !Number.isFinite(value));

function rowIdentity(record: unknown, key: string, variant: string | null = null): string | null {
  if (variant !== null) {
    const data = ((record as { variants?: unknown } | null | undefined)?.variants as { [key: string]: unknown } | null | undefined)?.[variant];
    const identity = (data as { workload_identity?: unknown } | null | undefined)?.workload_identity;
    if (!identity || typeof identity !== 'object' || typeof (identity as { fingerprint?: unknown }).fingerprint !== 'string' || (identity as { fingerprint?: unknown }).fingerprint !== identityHash((identity as { inputs?: unknown }).inputs)) return null;
    const model = (((identity as { inputs?: unknown }).inputs as { requested?: unknown } | null | undefined)?.requested as { model?: unknown } | null | undefined)?.model;
    if ((model as { status?: unknown } | null | undefined)?.status !== 'not-applicable' && (model as { reuse_eligible?: unknown } | null | undefined)?.reuse_eligible !== true) return null;
    return (identity as { fingerprint: string }).fingerprint;
  }
  const row = ((((record as { workload_identity?: unknown } | null | undefined)?.workload_identity as { logical_inputs?: unknown } | null | undefined)?.logical_inputs as { rows?: unknown } | null | undefined)?.rows as { [key: string]: unknown } | null | undefined)?.[key];
  if (!row || typeof row !== 'object' || typeof (row as { fingerprint?: unknown }).fingerprint !== 'string' || (row as { fingerprint?: unknown }).fingerprint !== identityHash((row as { inputs?: unknown }).inputs)) return null;
  return (row as { fingerprint: string }).fingerprint;
}

function identityClassification(id: string, context: string, row: RowReading, currentRecord: unknown, priorRecord: unknown, current: unknown, prior: unknown, variant: string | null = null) {
  const currentId = rowIdentity(currentRecord, row.key, variant);
  const priorId = priorRecord ? rowIdentity(priorRecord, row.key, variant) : null;
  if (!currentId) return failedReading(id, context, row, 'current workload identity is missing or invalid', prior ?? null, current ?? null);
  if (!priorRecord) return { id, context, key: row.key, ...(variant ? { variant } : {}), verdict: 'no-compatible-prior', reason: `${row.label}: no compatible prior recorded`, prior: null, current, workload_id: currentId, prior_workload_id: null };
  if (!priorId || priorId !== currentId) return { id, context, key: row.key, ...(variant ? { variant } : {}), verdict: 'no-compatible-prior', reason: `${row.label}: prior workload identity is missing or differs`, prior: null, current, workload_id: currentId, prior_workload_id: priorId };
  return { workload_id: currentId, prior_workload_id: priorId };
}

/** @template {object} T @param {T & { key: string }} classification @returns {T & { comparison_class?: string }} */
function withRowClass<T extends { key: string }>(classification: T): T & { comparison_class?: string } {
  const rowClass = ROW_BY_KEY.get(classification.key)?.comparison_class;
  return rowClass ? { ...classification, comparison_class: rowClass } : classification;
}

/** @param {Classification[]} classifications @returns {Classification[]} */
function withRowClasses<C extends Classification>(classifications: C[]) {
  return classifications.map(withRowClass);
}

const failedReading = (id: string, context: string, row: RowReading, reason: unknown, prior: unknown, current: unknown) => ({
  id,
  context,
  key: row.key,
  verdict: 'failed',
  invalid: true,
  reason: `${row.label}: ${reason}`,
  prior,
  current,
});

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasMeasurement = (record: unknown) => WALL_INPROC_TOKENS.some((row) => rowValue(record, row.key) !== null && rowValue(record, row.key) !== undefined) || WALL_INPROC_TOKENS.some((row) => valueError(record, row));

// compare.mjs's JSON: baseline is prior, local is current, gated on row.band; reversedJson confirms
// a row beyond band. A null current with an `errors` entry is a failed measurement, not an absence.
/** @returns {Classification[]} */
export function classifyCompare(compareJson: unknown, reversedJson: unknown, { requireIdentity = false } = {}): Classification<string | null>[] {
  const versions = (compareJson as { versions?: unknown } | null | undefined)?.versions;
  const validVersions = Array.isArray(versions) && versions.length === 2 && versions.every((version: unknown) => typeof version === 'string' && version.length > 0) && versions[0] !== versions[1];
  const reversedVersions = (reversedJson as { versions?: unknown } | null | undefined)?.versions;
  const validReversedVersions =
    !reversedJson ||
    (Array.isArray(reversedVersions) &&
      reversedVersions.length === 2 &&
      reversedVersions.every((version: unknown) => typeof version === 'string' && version.length > 0) &&
      reversedVersions[0] !== reversedVersions[1] &&
      reversedVersions[0] === (versions as { [index: number]: unknown } | null | undefined)?.[1] &&
      reversedVersions[1] === (versions as { [index: number]: unknown } | null | undefined)?.[0]);
  if (
    !validVersions ||
    !validReversedVersions ||
    !isRecord((compareJson as { results?: unknown } | null | undefined)?.results) ||
    !isRecord(((compareJson as { results?: unknown }).results as { [key: string]: unknown })[versions[0]]) ||
    !isRecord(((compareJson as { results?: unknown }).results as { [key: string]: unknown })[versions[1]]) ||
    (reversedJson && (!isRecord((reversedJson as { results?: unknown }).results) || !isRecord(((reversedJson as { results?: unknown }).results as { [key: string]: unknown })[versions[0]]) || !isRecord(((reversedJson as { results?: unknown }).results as { [key: string]: unknown })[versions[1]])))
  ) {
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: `compare artifact is incomplete${(compareJson as { error?: unknown } | null | undefined)?.error ? `: ${(compareJson as { error?: unknown }).error}` : ''}`, prior: null, current: null }];
  }
  if (
    (compareJson as { error?: unknown }).error ||
    (reversedJson as { error?: unknown } | null | undefined)?.error ||
    (typeof (compareJson as { errors?: unknown }).errors === 'number' && (compareJson as { errors: number }).errors > 0) ||
    (typeof (reversedJson as { errors?: unknown } | null | undefined)?.errors === 'number' && (reversedJson as { errors: number }).errors > 0)
  ) {
    const error = (compareJson as { error?: unknown }).error ?? (reversedJson as { error?: unknown } | null | undefined)?.error ?? `error count ${(compareJson as { errors?: unknown }).errors ?? (reversedJson as { errors?: unknown }).errors}`;
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: `compare artifact is invalid: ${error}`, prior: null, current: null }];
  }
  const [baseline, local] = versions;
  const localResult = ((compareJson as { results?: unknown }).results as { [key: string]: unknown })[local];
  if (!hasMeasurement(localResult) || (reversedJson && !hasMeasurement(((reversedJson as { results?: unknown }).results as { [key: string]: unknown })[local]))) {
    return [{ id: 'compare/validity', context: 'compare', key: 'validity', verdict: 'failed', invalid: true, reason: 'compare artifact contains no current measurement readings or named errors', prior: null, current: null }];
  }
  const out: Classification<string | null>[] = [];
  for (const row of WALL_INPROC_TOKENS) {
    const current = rowValue(localResult, row.key);
    const prior = rowValue(((compareJson as { results?: unknown }).results as { [key: string]: unknown })[baseline], row.key);
    const currentError = valueError(localResult, row);
    const priorError = valueError(((compareJson as { results?: unknown }).results as { [key: string]: unknown })[baseline], row);
    const reversedError = reversedJson && (valueError(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[local], row) ?? valueError(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[baseline], row));
    const reversedCurrent = reversedJson ? rowValue(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[local], row.key) : null;
    const reversedPrior = reversedJson ? rowValue(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[baseline], row.key) : null;
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
    const identity = requireIdentity ? identityClassification(`compare/${row.key}`, 'compare', row, localResult, ((compareJson as { results?: unknown }).results as { [key: string]: unknown })[baseline], current, prior) : null;
    if (identity && 'verdict' in identity) {
      out.push(identity);
      continue;
    }
    if (requireIdentity && reversedJson) {
      const forwardCurrentId = rowIdentity(localResult, row.key);
      const forwardPriorId = rowIdentity(((compareJson as { results?: unknown }).results as { [key: string]: unknown })[baseline], row.key);
      if (rowIdentity(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[local], row.key) !== forwardCurrentId || rowIdentity(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[baseline], row.key) !== forwardPriorId) {
        out.push(failedReading(`compare/${row.key}`, 'compare', row, 'reversed workload identity is missing or differs', prior, current));
        continue;
      }
    }
    const reversed = reversedJson
      ? {
          prior: rowValue(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[baseline], row.key) as number | null | undefined,
          current: rowValue(((reversedJson as { results?: unknown }).results as { [key: string]: unknown } | null | undefined)?.[local], row.key) as number | null | undefined,
        }
      : undefined;
    const c = classify(row, prior as number | null | undefined, current as number, { reversed, useCross: false });
    out.push({ id: `compare/${row.key}`, context: 'compare', key: row.key, ...c, prior, current, ...(identity ?? {}) });
  }
  return withRowClasses(out);
}

// The gate uses the same identity-aware classification as the report to decide whether a reversed
// timing run is warranted; a workload that cannot be compared must not trigger another measurement.
export function shouldRunReversedCompare(compareJson: unknown) {
  return classifyCompare(compareJson, null, { requireIdentity: true }).some((classification) => classification.verdict === 'moved');
}

// Cross-sitting readings sharing one row set: hub/13k/26k feed the consistent-growth rule, while
// stress and each store battery form a lone group gated on the cross band alone.
/** @returns {Classification[]} */
export function classifyCrossGroup(runJsonByStep: Readonly<Record<string, unknown>>, priorSteps: Readonly<Record<string, unknown>> | null | undefined, { requireIdentity = false } = {}): Classification<string | null>[] {
  const stepIds = Object.keys(runJsonByStep);
  const deltas: Record<string, Record<string, number>> = {};
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
      deltas[row.key][stepId] = ((current as number) - (prior as number)) / (prior as number);
    }
  }
  const out: Classification<string | null>[] = [];
  for (const stepId of stepIds) {
    const runJson = runJsonByStep[stepId];
    if ((runJson as { error?: unknown } | null | undefined)?.error || (typeof (runJson as { errors?: unknown } | null | undefined)?.errors === 'number' && (runJson as { errors: number }).errors > 0) || !runJson || typeof runJson !== 'object') {
      const error = (runJson as { error?: unknown } | null | undefined)?.error ?? (typeof (runJson as { errors?: unknown } | null | undefined)?.errors === 'number' ? `error count ${(runJson as { errors?: unknown }).errors}` : null);
      out.push({ id: `${stepId}/validity`, context: stepId, key: 'validity', verdict: 'failed', invalid: true, reason: `${stepId}: artifact is incomplete${error ? `: ${error}` : ''}`, prior: null, current: null });
      continue;
    }
    const hasReadings =
      WALL_INPROC_TOKENS.some((row) => rowValue(runJson, row.key) !== null && rowValue(runJson, row.key) !== undefined) ||
      WALL_INPROC_TOKENS.some((row) => ((runJson as { errors?: unknown }).errors as { [key: string]: unknown } | null | undefined)?.[row.key]) ||
      Boolean(((runJson as { inproc?: unknown }).inproc as { error?: unknown } | null | undefined)?.error);
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
      const c = classify(row, prior as number | null | undefined, current as number, { useCross: true, sizeDeltas });
      out.push({ id: `${stepId}/${row.key}`, context: stepId, key: row.key, ...c, prior, current, ...(identity ?? {}) });
    }
  }
  return withRowClasses(out);
}

// One eval.mjs-shaped JSON (nfcorpus or fever): one classification per variant per quality row.
// retrievalOwed decides which branch of the quality rule applies (see classify.ts).
/** @returns {Classification[]} */
export function classifyEval(stepId: string, evalJson: unknown, priorEvalJson: unknown, retrievalOwed: boolean, { requireIdentity = false } = {}): Classification[] {
  const out: Classification[] = [];
  const variants = Object.entries((evalJson as { variants?: unknown } | null | undefined)?.variants ?? {});
  const evalErrors = Number((evalJson as { errors?: unknown } | null | undefined)?.errors ?? 0);
  const evalErrorsMalformed = (evalJson as { errors?: unknown } | null | undefined)?.errors !== undefined && (!Number.isFinite(evalErrors) || evalErrors < 0);
  if (!evalJson || (evalJson as { error?: unknown }).error || (evalJson as { incomplete?: unknown }).incomplete === true || evalErrors > 0 || evalErrorsMalformed || variants.length === 0) {
    const reason = (evalJson as { error?: unknown } | null | undefined)?.error ?? (evalErrors > 0 ? `${evalErrors} retrieval error(s)` : `${stepId}: artifact is incomplete`);
    out.push({ id: `${stepId}/validity`, context: stepId, key: 'validity', verdict: 'failed', invalid: true, reason, prior: null, current: null });
    return out;
  }
  for (const [variantName, rawVariantData] of variants) {
    const variantData = rawVariantData && typeof rawVariantData === 'object' ? rawVariantData : {};
    const priorVariants = (priorEvalJson as { variants?: unknown } | null | undefined)?.variants;
    const hasPriorVariant = priorVariants !== null && typeof priorVariants === 'object' && !Array.isArray(priorVariants) && Object.hasOwn(priorVariants, variantName);
    const rawPriorVariant = hasPriorVariant ? (priorVariants as Record<string, unknown>)[variantName] : undefined;
    const priorVariantMalformed = hasPriorVariant && (rawPriorVariant === null || typeof rawPriorVariant !== 'object' || Array.isArray(rawPriorVariant));
    const priorVariant = priorVariantMalformed ? null : rawPriorVariant;
    const validityId = `${stepId}/${variantName}/validity`;
    const errors = Number((variantData as { errors?: unknown }).errors ?? 0);
    const errorDetails = (variantData as { error_details?: unknown }).error_details ?? (variantData as { errors_detail?: unknown }).errors_detail;
    const detail = Array.isArray(errorDetails) && errorDetails.length > 0 ? ` (${errorDetails.map((e: unknown) => `${(e as { qid?: unknown }).qid ?? 'unknown qid'}: ${(e as { error?: unknown }).error ?? e}`).join('; ')})` : '';
    const errorsMalformed = (variantData as { errors?: unknown }).errors !== undefined && (!Number.isFinite(errors) || errors < 0);
    const currentMissing = QUALITY_ROWS.filter((row) => (variantData as { [key: string]: unknown })[row.key] === null || (variantData as { [key: string]: unknown })[row.key] === undefined);
    const currentNonFinite = QUALITY_ROWS.filter((row) => invalidValue((variantData as { [key: string]: unknown })[row.key]));
    const currentOutOfRange = QUALITY_ROWS.filter((row) => !currentMissing.includes(row) && !currentNonFinite.includes(row) && metricRangeError(row.key, (variantData as { [key: string]: unknown })[row.key]));
    let invalidVariant = false;
    if (errors > 0 || errorsMalformed || (variantData as { incomplete?: unknown }).incomplete === true || currentMissing.length > 0 || currentNonFinite.length > 0 || currentOutOfRange.length > 0) {
      const reason = errors > 0 ? `${errors} retrieval error(s)${detail}` : `incomplete artifact${detail}`;
      const missing = currentMissing.map((row) => row.key).join(', ');
      const nonFinite = currentNonFinite.map((row) => row.key).join(', ');
      const outOfRange = currentOutOfRange.map((row) => `${row.key} (${metricRangeError(row.key, (variantData as { [key: string]: unknown })[row.key])})`).join(', ');
      const suffix = [missing && `missing metric(s): ${missing}`, nonFinite && `non-finite metric(s): ${nonFinite}`, outOfRange && `out-of-range metric(s): ${outOfRange}`].filter(Boolean).join('; ');
      out.push({ id: validityId, context: `${stepId}/${variantName}`, key: 'validity', variant: variantName, verdict: 'failed', invalid: true, reason: `${variantName}: ${reason}`, prior: null, current: null });
      if (suffix) out[out.length - 1].reason += `; ${suffix}`;
      invalidVariant = true;
    }
    const priorErrors = Number((priorVariant as { errors?: unknown } | null | undefined)?.errors ?? 0);
    const priorErrorsMalformed = (priorVariant as { errors?: unknown } | null | undefined)?.errors !== undefined && (!Number.isFinite(priorErrors) || priorErrors < 0);
    const priorMissing = priorVariant && QUALITY_ROWS.some((row) => (priorVariant as { [key: string]: unknown })[row.key] === null || (priorVariant as { [key: string]: unknown })[row.key] === undefined);
    const priorNonFinite = priorVariant && QUALITY_ROWS.some((row) => invalidValue((priorVariant as { [key: string]: unknown })[row.key]));
    const priorOutOfRange = priorVariant && QUALITY_ROWS.some((row) => row.key in (priorVariant as object) && !invalidValue((priorVariant as { [key: string]: unknown })[row.key]) && metricRangeError(row.key, (priorVariant as { [key: string]: unknown })[row.key]));
    const priorEvalErrors = Number((priorEvalJson as { errors?: unknown } | null | undefined)?.errors ?? 0);
    const priorEvalErrorsMalformed = (priorEvalJson as { errors?: unknown } | null | undefined)?.errors !== undefined && (!Number.isFinite(priorEvalErrors) || priorEvalErrors < 0);
    if (
      (priorEvalJson as { error?: unknown } | null | undefined)?.error ||
      (priorEvalJson as { incomplete?: unknown } | null | undefined)?.incomplete === true ||
      priorEvalErrors > 0 ||
      priorEvalErrorsMalformed ||
      priorVariantMalformed ||
      (priorVariant && (priorErrors > 0 || priorErrorsMalformed || (priorVariant as { incomplete?: unknown }).incomplete === true || priorMissing || priorNonFinite || priorOutOfRange))
    ) {
      const priorReason =
        (priorEvalJson as { error?: unknown } | null | undefined)?.error ??
        (priorEvalErrors > 0 ? `${priorEvalErrors} retrieval error(s)` : priorVariantMalformed ? 'malformed variant' : priorNonFinite ? 'non-finite metric' : priorOutOfRange ? 'out-of-range metric' : priorMissing ? 'missing metric' : `${priorErrors} retrieval error(s)`);
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
      const current = (variantData as { [key: string]: unknown })[row.key];
      const prior = priorVariant ? (priorVariant as { [key: string]: unknown })[row.key] : null;
      const identity = requireIdentity ? identityClassification(`${stepId}/${variantName}/${row.key}`, `${stepId}/${variantName}`, row, evalJson, priorEvalJson, current, prior, variantName) : null;
      if (identity && 'verdict' in identity) {
        out.push(identity);
        continue;
      }
      if (invalidValue(prior)) {
        out.push({ id: `${stepId}/${variantName}/${row.key}`, context: `${stepId}/${variantName}`, key: row.key, variant: variantName, verdict: 'failed', invalid: true, reason: `${row.label}: prior ${variantName} artifact is non-finite`, prior, current });
        continue;
      }
      const c = classify(row, prior as number | null | undefined, current as number, { retrievalOwed });
      out.push({ id: `${stepId}/${variantName}/${row.key}`, context: `${stepId}/${variantName}`, key: row.key, variant: variantName, ...c, prior, current, ...(identity ?? {}) });
    }
  }
  return withRowClasses(out);
}

// Same-sitting invariant: a watcher regressed to repeating bulk_change_ms passes a prior/current
// compare, since two equal numbers stay in band. 0.7 (2026-09-07): derivation in PLAN.md 3.63.
const WATCH_SANITY_RATIO = 0.7;
export function classifyWatchSanity(context: string, runJson: unknown) {
  const change = (runJson as { bulk_change_ms?: unknown } | null | undefined)?.bulk_change_ms;
  const watch = (runJson as { bulk_watch_ms?: unknown } | null | undefined)?.bulk_watch_ms;
  if (typeof change !== 'number' || typeof watch !== 'number' || change === 0) return null;
  const ratio = watch / change;
  if (ratio <= WATCH_SANITY_RATIO) return null;
  const label = (ROW_BY_KEY.get('bulk_watch_ms') as Row).label;
  const reason = `${label}: ${watch}ms is ${(ratio * 100).toFixed(1)}% of bulk_change_ms's ${change}ms on ${context}, at or above the ${(WATCH_SANITY_RATIO * 100).toFixed(0)}% sanity ratio -- the watcher path is not separating from the unwatched reparse`;
  return withRowClass({ id: `${context}/bulk_watch_ms-sanity`, context, key: 'bulk_watch_ms', verdict: 'failed', observation: 'diagnostic', reason, prior: null, current: watch });
}

// One classification per store/size whose run.mjs JSON carries both bulk rows, keyed the same way
// classifyCrossGroup's caller already groups them (hub, scale-13k, battery-duckdb-hub, ...).
export function watchSanityGroup(runJsonById: Readonly<Record<string, unknown>>) {
  const out: Classification[] = [];
  for (const [id, runJson] of Object.entries(runJsonById)) {
    const c = classifyWatchSanity(id, runJson);
    if (c) out.push(c);
  }
  return out;
}

// A raw row verdict describes the observation. Release severity is a separate decision: timing,
// quality, and output observations warn unless the artifact names an explicit requirement.
export function classificationSeverity(classification: SeverityInput) {
  if (classification.invalid === true) return 'BLOCK';
  const observed = !['flat', 'noise', 'no-prior', 'no-compatible-prior'].includes(classification.verdict);
  if (classification.semantic_change === 'unexplained') return 'BLOCK';
  if (observed && (classification.release_requirement === 'block' || classification.required === true)) return 'BLOCK';
  if (observed && classification.observation === 'diagnostic') return 'WARN';
  if (observed && /proxied|no dedicated spread|no spread of its own/.test(ROW_BY_KEY.get(classification.key as string)?.source ?? '')) return 'INFO';
  if (observed) return 'WARN';
  return 'INFO';
}

export function withSeverity<T extends SeverityInput>(classifications: readonly T[]) {
  return classifications.map((classification) => ({ ...classification, severity: classificationSeverity(classification) }));
}

// BLOCK reasons come only from invalid or explicitly required evidence. Historical timing,
// relevance, and output observations remain in the report as warnings.
export function aggregateVerdict<C extends SeverityInput & { id: string; reason?: unknown }, F>(classifications: readonly C[], failedStageReasons: readonly F[], accepted: Readonly<Record<string, { reason?: unknown } | null | undefined>> = {}) {
  // An owner decision is evidence-specific. It never makes an invalid reading comparable.
  const blocking = classifications.filter((c) => classificationSeverity(c) === 'BLOCK' && (!accepted[c.id]?.reason || c.invalid));
  const reasons = [...failedStageReasons, ...blocking.map((c) => c.reason)];
  return { verdict: reasons.length > 0 ? 'BLOCK' : 'PASS', reasons };
}
