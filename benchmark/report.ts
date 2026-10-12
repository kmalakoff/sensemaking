// Renders a sitting's release-gate.{json,md} into the sitting directory under .tmp/sittings/, and
// with --release <version> also the record benchmark/reports/<date>-<version>-release-gate.{json,md}.
// Recomputes classification from the sitting's own step JSONs and the earlier records every time,
// so re-running this against the same sitting is idempotent, byte for byte. Never re-measures.
//
// usage: node benchmark/report.ts [--sitting <dir>] [--out <dir>] [--release <version>]
//        node benchmark/report.ts --accept <row id | stage reason> --reason "<owner's words>"
//
// Releasing a PASS (or a BLOCK whose every blocking row carries an accepted override) repoints
// BENCHMARKING.md's numbers-of-record table and rewrites the shipped store-selection summary;
// a BLOCK, or an unreleased sitting, leaves both exactly as they were.
//
// Every exported function takes its target paths through an options object, defaulted to the
// real repo locations -- test/integration/docs.test.ts points them at scratch instead, so
// exercising this module never writes into the tracked benchmark/reports/ or BENCHMARKING.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { exitAboveAdmissionLimit } from './lib/fixed-work-measurement.ts';
import { PROFILES, QUALITY_SCOPE } from './lib/gates.ts';
import { MEASURE_VERSION } from './lib/measure.ts';
import { compareNativeCapabilityArtifacts } from './lib/native-capability-compare.ts';
import { compareNativeHydrationArtifacts } from './lib/native-hydration-compare.ts';
import { compareNativeUpdateArtifacts, nativeEvidenceExecutionPlan } from './lib/native-update-contract.ts';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES } from './lib/portable-quality.ts';
import { mdTable } from './lib/render.ts';
import { compactRetainedQuality, compactStep } from './lib/report-compaction.ts';
import { validateResultSetArtifact } from './lib/result-sets.ts';
import { validateRetainedQualityRecord } from './lib/retained-quality.ts';
import { COMPARISON_CLASSES, ROW_BY_KEY, ROWS } from './lib/rows.ts';
import { validateSharedSnippetArtifact } from './lib/shared-snippet-contract.ts';
import { DEFAULT_STORE, LEGACY_QUALITY_STEPS, OFFERED, ROOT, STAGES } from './lib/stages.ts';
import { captureIdentity, resolveCaptureDirectory, validateStoreDumpArtifact as validateRetainedStoreDumpArtifact } from './lib/store-dump-evidence.ts';
import { aggregateVerdict, classificationSeverity, classifyCompare, classifyCrossGroup, classifyEval, compareVersions, findPriorReports, priorStepLookup, shouldRunReversedCompare, watchSanityGroup, withSeverity } from './lib/verdict.ts';
import { identityHash } from './lib/workload-identity.ts';

type Classification = ReturnType<typeof classifyEval>[number] & { severity?: string };
type PriorLookup = ReturnType<typeof priorStepLookup>;
interface ReportLocations {
  reportsDir?: string;
  sittingsDir?: string;
  currentRoot?: string;
}
interface BuildOptions extends ReportLocations {
  releaseVersionOverride?: string;
  nativeMatrixPath?: string | null;
}
interface PersistOptions {
  sittingDir: string;
  outputDir?: string;
  reportsDir?: string;
  benchmarkingMdPath?: string;
  storeSummaryPath?: string | null;
  analysisOnly?: boolean;
}
type AcceptanceEntries = Record<string, { reason?: unknown; date?: unknown; evidence_fingerprint?: unknown }>;

export const REPORTS_DIR = join(ROOT, 'benchmark', 'reports');
export const SITTINGS_DIR = join(ROOT, '.tmp', 'sittings');
export const BENCHMARKING_MD = join(ROOT, 'BENCHMARKING.md');
export const STORE_BENCHMARK_SUMMARY_MD = join(ROOT, 'skills', 'sense-setup', 'references', 'store-benchmarks.md');
export const NUMBERS_START = '<!-- numbers -->';
export const NUMBERS_END = '<!-- /numbers -->';
const STORE_SUMMARY_VERSION_RE = /<!-- sense-store-benchmark release=(\d+\.\d+\.\d+) -->/;

// A record is named for the release it gates. Until --release names one, the sitting's report
// lives beside its data as <sitting>/release-gate.{json,md}, so two sittings can never collide.
export const SITTING_REPORT = 'release-gate';
export function reportBase(date: unknown, version: unknown) {
  return `${date}-${version}-release-gate`;
}

const readJson = (p: string): unknown => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

const STORE_DUMP_REPORT_EXAMPLES = 8;
function storeDumpEvidencePart(value: unknown) {
  if (typeof value === 'string') return value.length <= 160 ? value : `${value.slice(0, 160)}…`;
  if ((value as { truncated_utf8?: unknown } | null | undefined)?.truncated_utf8 === true && typeof (value as { sha256: unknown }).sha256 === 'string' && Number.isSafeInteger((value as { bytes: unknown }).bytes)) return `sha256:${(value as { sha256: unknown }).sha256} (${(value as { bytes: unknown }).bytes} bytes)`;
  return '[malformed representative]';
}

function storeDumpCategoryEvidence(entries: unknown) {
  if (Number.isSafeInteger(entries) && (entries as number) >= 0) return { count: entries, diagnostics: 'raw entries retained in sitting' };
  if (Array.isArray(entries)) {
    const examples = entries.slice(0, STORE_DUMP_REPORT_EXAMPLES).map((entry) => `${storeDumpEvidencePart((entry as { store: unknown }).store)}/${storeDumpEvidencePart((entry as { artifact: unknown }).artifact)}:${storeDumpEvidencePart((entry as { identity: unknown }).identity)}`);
    const omitted = entries.length - examples.length;
    return { count: entries.length, diagnostics: [...(examples.length > 0 ? [examples.join(', ')] : []), ...(omitted > 0 ? [`${omitted} omitted`] : []), 'legacy evidence has no category digest'].join('; ') };
  }
  if (entries && Number.isSafeInteger((entries as { count: unknown }).count) && typeof (entries as { sha256: unknown }).sha256 === 'string' && Array.isArray((entries as { representatives: unknown[] }).representatives) && Number.isSafeInteger((entries as { omitted: unknown }).omitted)) {
    const examples = (entries as { representatives: unknown[] }).representatives.map((entry) => `${storeDumpEvidencePart((entry as { store: unknown }).store)}/${storeDumpEvidencePart((entry as { artifact: unknown }).artifact)}:${storeDumpEvidencePart((entry as { identity: unknown }).identity)}`);
    return { count: (entries as { count: unknown }).count, diagnostics: [...(examples.length > 0 ? [examples.join(', ')] : []), ...((entries as { omitted: number }).omitted > 0 ? [`${(entries as { omitted: unknown }).omitted} omitted`] : []), `digest ${(entries as { sha256: unknown }).sha256}`].join('; ') };
  }
  return { count: 'unsupported', diagnostics: 'unsupported store-dump evidence format' };
}

function evidenceValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(evidenceValue);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'resumed')
      .map(([key, child]) => [key, evidenceValue(child)])
  );
}

function artifactEvidence(sittingDir: string, id: string, artifact: unknown) {
  const paths = [];
  const captures = (artifact as { captures?: Record<string, unknown> | null | undefined } | null | undefined)?.captures;
  if (captures && typeof captures === 'object') {
    for (const path of Object.values(captures)) {
      if (typeof path !== 'string') continue;
      try {
        const absolute = resolveCaptureDirectory(sittingDir, path);
        paths.push({ path, identity: captureIdentity(absolute) });
      } catch (error) {
        paths.push({ path, error: (error as { message?: unknown } | null | undefined)?.message ?? String(error) });
      }
    }
  }
  const artifactPath = join(sittingDir, `${id}.json`);
  const raw = existsSync(artifactPath) ? readFileSync(artifactPath, 'utf8') : JSON.stringify(artifact);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { artifact: evidenceValue(parsed), captures: paths.sort((a, b) => a.path.localeCompare(b.path)) };
}

function readArtifact(path: string): unknown {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function evidenceArtifactIds(id: string, context: string) {
  if (context === 'compare') return ['compare', 'compare-reversed'];
  if (id.startsWith('compare/')) return ['compare', 'compare-reversed'];
  return [context.split('/')[0]];
}

export function classificationEvidence(sittingDir: string, id: string, classification: Pick<Classification, 'context'>) {
  return evidenceArtifactIds(id, classification.context).map((artifactId) => {
    const path = join(sittingDir, `${artifactId}.json`);
    if (!existsSync(path)) return { id: artifactId, evidence: null };
    return { id: artifactId, evidence: artifactEvidence(sittingDir, artifactId, readArtifact(path)) };
  });
}

// The stage-failure contract, shared with gate.ts: a stage failure is named `<step id>: <status>`
// wherever it appears, in sitting.failed_stage_reasons, in the report's stage_reasons, and as the
// argument --accept takes.
const stageReason = (stepId: unknown, status: unknown) => `${stepId}: ${status}`;

// Statuses only sittings recorded before the gate dropped its time limits carry: timeout (a step
// killed at its limit) and blocked (the quiet-machine wait giving up). Read so that evidence still
// renders; the gate never writes them.
const HISTORICAL_FAILED_STATUSES = ['timeout', 'blocked'];
// cancelled: the operator stopped the step; never ok, never accepted, re-run on resume.
const FAILED_STATUSES = new Set(['failed', 'cancelled', ...HISTORICAL_FAILED_STATUSES]);

// Recomputed from the recorded steps after every run, so a resume that fixes a failure drops its
// reason and a resume that does not keeps it. A failure never leaves the report by being skipped.
export function failedStageReasons(steps: Record<string, unknown> | null | undefined) {
  return Object.values(steps ?? {})
    .filter((s) => s && typeof s === 'object' && FAILED_STATUSES.has((s as { status: string }).status))
    .map((s) => stageReason((s as { id: unknown }).id, (s as { status: unknown }).status));
}

// What the owner has accepted on this sitting's own report, row ids and stage reasons together.
// Acceptance belongs to the sitting, so a changed tree, which is a new sitting, starts with none.
export const acceptanceFingerprint = (id: string, report: unknown, sittingDir: string) => {
  const classification = (report as { classifications: Classification[] }).classifications?.find((row) => (row as { id: unknown }).id === id);
  if (classification) {
    const reversedPath = classification.context === 'compare' && sittingDir ? join(sittingDir, 'compare-reversed.json') : null;
    const reversedArtifact = reversedPath && existsSync(reversedPath) ? identityHash(readFileSync(reversedPath, 'utf8')) : null;
    return identityHash({
      type: 'classification',
      measure_version: (report as { measure_version: unknown }).measure_version,
      id,
      verdict: classification.verdict,
      prior: classification.prior ?? null,
      current: classification.current ?? null,
      workload_id: classification.workload_id ?? null,
      prior_workload_id: classification.prior_workload_id ?? null,
      evidence: classificationEvidence(sittingDir, id, classification),
      reversed_artifact: reversedArtifact,
    });
  }
  const separator = id.lastIndexOf(': ');
  const stepId = separator > 0 && FAILED_STATUSES.has(id.slice(separator + 2)) ? id.slice(0, separator) : null;
  const artifactPath = stepId && sittingDir ? join(sittingDir, `${stepId}.json`) : null;
  return stepId
    ? identityHash({
        type: 'stage',
        measure_version: (report as { measure_version: unknown }).measure_version,
        id,
        step: evidenceValue((report as { steps_status: Record<string, unknown> | null | undefined }).steps_status?.[stepId] ?? null),
        artifact: artifactPath ? artifactEvidence(sittingDir, stepId, readArtifact(artifactPath)) : null,
      })
    : null;
};

const acceptanceApplies = (id: string, entry: unknown, report: unknown, sittingDir: string) =>
  typeof (entry as { evidence_fingerprint?: unknown } | null | undefined)?.evidence_fingerprint === 'string' && (entry as { evidence_fingerprint: unknown }).evidence_fingerprint === acceptanceFingerprint(id, report, sittingDir);

export function acceptedIds(sittingDir: string) {
  const report = readJson(join(sittingDir, `${SITTING_REPORT}.json`));
  const sitting = readJson(join(sittingDir, 'sitting.json'));
  const current = report ? { ...report, steps_status: (sitting as { steps?: Record<string, unknown> | null | undefined } | null | undefined)?.steps ?? (report as { steps_status: Record<string, unknown> | null | undefined }).steps_status } : report;
  return new Set(
    Object.entries((report as { accepted?: AcceptanceEntries } | null | undefined)?.accepted ?? {})
      .filter(([id, entry]) => acceptanceApplies(id, entry, current, sittingDir))
      .map(([id]) => id)
  );
}

// Whether a step an earlier run recorded is done for this resume. Done is the recorded status,
// never the existence of the step's out JSON: a failed step writes one too, and reading that as
// done drops the failure from the report. A failure stays failed and is re-run unless the owner
// has accepted its reason, which is the decision to keep it.
export function doneOnResume(stepId: string, recorded: unknown, accepted = new Set<string>()) {
  if (!(recorded as { status?: unknown } | null | undefined)?.status) return false;
  if ((recorded as { status: unknown }).status === 'ok') return true;
  // A cancelled step never resumes as done, and no acceptance applies to it.
  if ((recorded as { status: unknown }).status === 'cancelled') return false;
  return accepted.has(stageReason(stepId, (recorded as { status: unknown }).status));
}

// The stage failures still blocking: an accepted one leaves the verdict the way an accepted row
// does, and stays in the report beside the owner's words.
const blockingStageReasons = (stageReasons: readonly string[], accepted: AcceptanceEntries) => stageReasons.filter((r) => !accepted[r]?.reason);

const STEP_STATUSES = new Set(['ok', 'failed', 'cancelled', 'owed-unmet', 'not-owed', 'not-run', ...HISTORICAL_FAILED_STATUSES]);

function owedStepMap(sitting: unknown) {
  const owed = (sitting as { owed: Record<string, unknown> | null | undefined }).owed ?? {};
  const known = new Map(STAGES.flatMap((stage) => stage.steps).map((step) => [step.id, { step, owed: step.owedBy === 'always' || Object.hasOwn(owed, step.owedBy) }]));
  for (const step of LEGACY_QUALITY_STEPS) known.set(step.id, { step, owed: (sitting as { quality_scope: unknown }).quality_scope !== QUALITY_SCOPE && Object.hasOwn(owed, step.owedBy) });
  return known;
}

function coverageErrors(sitting: unknown) {
  const known = owedStepMap(sitting);
  const errors = [];
  if ((sitting as { quality_scope: unknown }).quality_scope !== undefined && (sitting as { quality_scope: unknown }).quality_scope !== QUALITY_SCOPE) errors.push(`coverage: unknown quality scope; expected ${QUALITY_SCOPE}`);
  if ((sitting as { profile: unknown }).profile !== undefined || (sitting as { effective_requirements: unknown }).effective_requirements !== undefined) {
    if (!PROFILES.includes((sitting as { profile: string }).profile)) errors.push(`coverage: profile must be ${PROFILES.join(' or ')}`);
    if (!(sitting as { effective_requirements: unknown }).effective_requirements || identityHash((sitting as { effective_requirements: unknown }).effective_requirements) !== identityHash((sitting as { owed: Record<string, unknown> | null | undefined }).owed ?? {}))
      errors.push('coverage: effective_requirements must match owed selection');
  }
  for (const [id, recorded] of Object.entries((sitting as { steps: Record<string, unknown> | null | undefined }).steps ?? {})) {
    const definition = known.get(id) ?? (id === 'compare-reversed' ? { step: { id, out: true }, owed: true } : null);
    if (!definition) {
      errors.push(`coverage: unknown step "${id}" is recorded`);
      continue;
    }
    if (!recorded || typeof recorded !== 'object' || !STEP_STATUSES.has((recorded as { status: string }).status)) {
      errors.push(`coverage: step "${id}" has an invalid status`);
      continue;
    }
    if (definition.owed && (recorded as { status: unknown }).status === 'not-owed') errors.push(`coverage: owed step "${id}" is marked not-owed`);
    if ((recorded as { status: unknown }).status === 'owed-unmet' && (!definition.owed || (definition.step as { unavailableExit?: number }).unavailableExit === undefined)) errors.push(`coverage: step "${id}" is recorded owed-unmet without an explicit unavailable exit`);
  }
  for (const [id, { owed }] of known) {
    if (!owed) continue;
    const recorded = (sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id];
    if (!(recorded as { status?: unknown } | null | undefined)?.status) errors.push(`coverage: owed step "${id}" has no recorded status`);
  }
  return errors;
}

function validateOracleArtifact(artifact: unknown) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return ['artifact is not an object'];
  if (typeof (artifact as { vault: unknown }).vault !== 'string' || (artifact as { vault: string }).vault.length === 0) errors.push('vault is missing');
  if (!Number.isSafeInteger((artifact as { filesCompared: unknown }).filesCompared) || (artifact as { filesCompared: number }).filesCompared <= 0) errors.push('filesCompared must be a positive integer');
  const differenceKeys = ['tags', 'links', 'deadLinks', 'headings'];
  for (const key of differenceKeys) if (!Number.isSafeInteger(((artifact as Record<string, unknown>)[key] as { differing?: unknown } | null | undefined)?.differing) || ((artifact as Record<string, unknown>)[key] as { differing: number }).differing < 0) errors.push(`${key}.differing is invalid`);
  if (!(artifact as { blockExtents: Record<string, unknown> | null | undefined }).blockExtents || typeof (artifact as { blockExtents: Record<string, unknown> | null | undefined }).blockExtents !== 'object') errors.push('blockExtents is missing');
  else {
    const extentKeys = ['frontmatterSections', 'eofPhantom', 'blockRefAnchor', 'commentSwallow', 'commentCascade', 'listContinuation', 'sectionMerge', 'edgeAdjust', 'trailingBlank', 'malformedFrontmatter', 'unexplained'];
    const actualKeys = Object.keys((artifact as { blockExtents: Record<string, unknown> }).blockExtents).sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify([...extentKeys].sort())) errors.push(`blockExtents keys must be exactly ${extentKeys.join(', ')}`);
    for (const key of extentKeys) if (!Number.isSafeInteger((artifact as { blockExtents: Record<string, unknown> }).blockExtents[key]) || ((artifact as { blockExtents: Record<string, unknown> }).blockExtents[key] as number) < 0) errors.push(`blockExtents.${key} must be a nonnegative integer`);
  }
  if (typeof (artifact as { parity: unknown }).parity !== 'boolean') errors.push('parity is missing');
  else if (differenceKeys.every((key) => Number.isSafeInteger(((artifact as Record<string, unknown>)[key] as { differing?: unknown } | null | undefined)?.differing)) && Number.isSafeInteger((artifact as { blockExtents: Record<string, unknown> }).blockExtents?.unexplained)) {
    const expectedParity = differenceKeys.every((key) => ((artifact as Record<string, unknown>)[key] as { differing: unknown }).differing === 0) && (artifact as { blockExtents: Record<string, unknown> }).blockExtents.unexplained === 0;
    if ((artifact as { parity: unknown }).parity !== expectedParity) errors.push(`parity does not match differing/unexplained counts (expected ${expectedParity})`);
  }
  return errors;
}

function newestSittingDir(sittingsDir = SITTINGS_DIR) {
  const dirs = existsSync(sittingsDir)
    ? readdirSync(sittingsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  if (dirs.length === 0) throw new Error(`no sitting under ${sittingsDir}; run node benchmark/gate.ts first`);
  return join(sittingsDir, dirs[dirs.length - 1]);
}

// Every step JSON this sitting could have produced, grouped into the same-sitting compare table,
// the hub/13k/26k growth group, a lone group per stress and per battery, and one per eval corpus.
function classifySitting(sittingDir: string, sitting: unknown, priorLookup: PriorLookup, { reportsDir = REPORTS_DIR, sittingsDir = SITTINGS_DIR, currentRoot = ROOT }: ReportLocations = {}) {
  // priorFrom records which report supplied each step's prior, for the run summary.
  const priorFrom: Record<string, string> = {};
  const priorHarnessMismatch: Record<string, { prior: unknown; current: string }> = {};
  const priorStep = (id: string) => {
    const hit = priorLookup(id);
    if (!hit) return null;
    if ((hit as { mismatch?: { prior: unknown; current: string } }).mismatch) {
      priorFrom[id] = `${hit.from} (harness ${(hit as { mismatch: { prior: unknown; current: string } }).mismatch.prior}, current ${(hit as { mismatch: { prior: unknown; current: string } }).mismatch.current}; not compared)`;
      priorHarnessMismatch[id] = (hit as { mismatch: { prior: unknown; current: string } }).mismatch;
      return null;
    }
    priorFrom[id] = hit.from;
    return hit.step;
  };
  const classifications: Classification[] = [];
  const steps: Record<string, unknown> = {};
  const verified = new Set<string>();
  for (const reason of coverageErrors(sitting)) classifications.push({ id: `coverage/${classifications.length}`, context: 'coverage', key: 'validity', verdict: 'failed', invalid: true, reason, prior: null, current: null });
  const invalidArtifact = (id: string, reason: unknown) => {
    classifications.push({ id: `${id}/validity`, context: id, key: 'validity', verdict: 'failed', invalid: true, reason, prior: null, current: null });
  };
  const expectedArtifacts = new Set([...STAGES.flatMap((stage) => stage.steps), ...LEGACY_QUALITY_STEPS].filter((step) => step.out).map((step) => step.id));
  expectedArtifacts.add('compare-reversed');
  const loadCurrent = (id: string, { compareWrapper = false } = {}) => {
    const path = join(sittingDir, `${id}.json`);
    if (!existsSync(path)) return null;
    let artifact: unknown;
    const raw = readFileSync(path, 'utf8');
    try {
      artifact = JSON.parse(raw);
    } catch (err) {
      const reason = `${id}: current artifact JSON is malformed: ${(err as { message?: unknown } | null | undefined)?.message ?? err}`;
      steps[id] = { error: reason, artifact_text: raw };
      invalidArtifact(id, reason);
      return null;
    }
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      const reason = `${id}: current artifact JSON is not an object`;
      steps[id] = { error: reason, artifact };
      invalidArtifact(id, reason);
      return null;
    }
    steps[id] = artifact;
    if (id === 'store-dump') {
      const errors = validateRetainedStoreDumpArtifact(artifact, sittingDir, (sitting as { baseline_version: unknown }).baseline_version, OFFERED);
      if (errors.length > 0) {
        const reason = `${id}: ${errors.join('; ')}`;
        invalidArtifact(id, reason);
        return null;
      }
      const status = ((sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id] as { status?: unknown } | null | undefined)?.status;
      if ((status === 'ok' && !(artifact as { ok: unknown }).ok) || (FAILED_STATUSES.has(status as string) && (artifact as { ok: unknown }).ok)) invalidArtifact(id, `${id}: artifact completion (${(artifact as { ok: unknown }).ok ? 'ok' : 'failed'}) disagrees with recorded step status ${status}`);
      return artifact;
    }
    if (id === 'oracle') {
      const errors = validateOracleArtifact(artifact);
      if (errors.length > 0) {
        const reason = `${id}: ${errors.join('; ')}`;
        invalidArtifact(id, reason);
        return null;
      }
      const status = ((sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id] as { status?: unknown } | null | undefined)?.status;
      if ((status === 'ok' && !(artifact as { parity: unknown }).parity) || (FAILED_STATUSES.has(status as string) && (artifact as { parity: unknown }).parity)) invalidArtifact(id, `${id}: artifact parity (${(artifact as { parity: unknown }).parity ? 'pass' : 'failure'}) disagrees with recorded step status ${status}`);
      return artifact;
    }
    if ((artifact as { measure_version: unknown }).measure_version === undefined) {
      const reason = `${id}: current artifact has no measure_version stamp`;
      invalidArtifact(id, reason);
      return null;
    }
    if ((artifact as { measure_version: unknown }).measure_version !== MEASURE_VERSION) {
      const reason = `${id}: current artifact measure_version ${(artifact as { measure_version: unknown }).measure_version} does not match current ${MEASURE_VERSION}`;
      invalidArtifact(id, reason);
      return null;
    }
    const status = ((sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id] as { status?: unknown } | null | undefined)?.status;
    if (status !== 'ok') {
      invalidArtifact(id, `${id}: recorded step status ${status ?? 'missing'} does not establish a usable measurement`);
      return null;
    }
    if (compareWrapper) {
      const shape = classifyCompare(artifact, null).find((classification) => classification.id === 'compare/validity');
      if (shape) {
        const reason = `${id}: ${shape.reason}`;
        invalidArtifact(id, reason);
        return null;
      }
      for (const version of (artifact as { versions: string[] }).versions) {
        if (((artifact as { results: Record<string, unknown> }).results[version] as { measure_version: unknown }).measure_version === undefined) {
          const reason = `${id}: inner result ${version} has no measure_version stamp`;
          invalidArtifact(id, reason);
          return null;
        }
        if (((artifact as { results: Record<string, unknown> }).results[version] as { measure_version: unknown }).measure_version !== MEASURE_VERSION) {
          const reason = `${id}: inner result ${version} measure_version ${((artifact as { results: Record<string, unknown> }).results[version] as { measure_version: unknown }).measure_version} does not match current ${MEASURE_VERSION}`;
          invalidArtifact(id, reason);
          return null;
        }
      }
    }
    return artifact;
  };

  let retainedArtifacts: Record<string, unknown> = {};
  const retainedQuality = (sitting as { owed: Record<string, unknown> | null | undefined }).owed?.['quality-revalidation'] ? loadCurrent('retained-quality') : null;
  let retainedQualityErrors: unknown[] = [];
  if (retainedQuality) {
    let errors: unknown[];
    try {
      errors = validateRetainedQualityRecord(retainedQuality, {
        reportsDir,
        sittingsDir,
        currentRoot,
        expectedSource: ((sitting as { retained_quality: unknown }).retained_quality as { source?: unknown } | null | undefined)?.source ?? null,
      } as Parameters<typeof validateRetainedQualityRecord>[1] & { reportsDir: string });
    } catch (error) {
      errors = [(error as { message?: unknown } | null | undefined)?.message ?? String(error)];
    }
    retainedQualityErrors = errors;
    if (errors.length > 0) invalidArtifact('retained-quality', `retained-quality: ${errors.join('; ')}`);
    else {
      retainedArtifacts = (retainedQuality as { artifacts: Record<string, unknown> }).artifacts;
      verified.add('retained-quality');
    }
  }
  if ((sitting as { owed: Record<string, unknown> | null | undefined }).owed?.['quality-revalidation'] && !verified.has('retained-quality') && retainedQualityErrors.length === 0) retainedQualityErrors = ['retained-quality step did not yield verified evidence'];
  const loadQuality = (id: string) => {
    if (!retainedArtifacts[id]) return loadCurrent(id);
    steps[id] = retainedArtifacts[id];
    return retainedArtifacts[id];
  };

  const compareJson = loadCurrent('compare', { compareWrapper: true });
  const reversedJson = loadCurrent('compare-reversed', { compareWrapper: true });
  if (compareJson && shouldRunReversedCompare(compareJson) && !((sitting as { steps: Record<string, unknown> | null | undefined }).steps?.['compare-reversed'] as { status?: unknown } | null | undefined)?.status) {
    invalidArtifact('compare-reversed', 'coverage: compare-reversed is required by a moved compare row but has no recorded status');
  }
  loadCurrent('store-dump');
  if (steps['store-dump'] && !classifications.some((classification) => classification.id === 'store-dump/validity')) verified.add('store-dump');
  loadCurrent('oracle');
  if (compareJson) {
    classifications.push(...classifyCompare(compareJson, reversedJson, { requireIdentity: true }));
  }

  const sharedSnippet = loadCurrent('shared-snippet');
  if (sharedSnippet) {
    try {
      validateSharedSnippetArtifact(sharedSnippet);
      verified.add('shared-snippet');
    } catch (error) {
      invalidArtifact('shared-snippet', `shared-snippet: ${(error as { message?: unknown } | null | undefined)?.message ?? error}`);
    }
  }
  const hydrationArtifacts = OFFERED.map((store) => loadCurrent(`native-hydration-${store}`)).filter(Boolean);
  const hydrationComparison = loadCurrent('native-hydration-comparison');
  if (hydrationComparison) {
    const recomputed = compareNativeHydrationArtifacts(hydrationArtifacts);
    if (!recomputed.valid || identityHash(recomputed) !== identityHash(hydrationComparison)) invalidArtifact('native-hydration-comparison', `native-hydration-comparison: ${recomputed.errors.join('; ') || 'persisted comparison disagrees with source artifacts'}`);
    else verified.add('native-hydration-comparison');
  }
  for (const id of ['result-sets-hub', 'result-sets-stress']) {
    const resultSets = loadCurrent(id);
    if (resultSets) {
      const errors = validateResultSetArtifact(resultSets, { measureVersion: MEASURE_VERSION, stores: OFFERED });
      if (errors.length > 0) invalidArtifact(id, `${id}: ${errors.join('; ')}`);
      else verified.add(id);
    }
  }

  const scaleGroup: Record<string, unknown> = {};
  if (compareJson) scaleGroup.hub = (compareJson as { results: Record<string, unknown> }).results[(compareJson as { versions: string[] }).versions[1]];
  for (const id of ['scale-13k', 'scale-26k']) {
    const j = loadCurrent(id);
    if (j) {
      scaleGroup[id] = j;
    }
  }
  if (Object.keys(scaleGroup).length > 0) {
    const priorScaleGroup = { hub: ((priorStep('compare') as { results?: unknown } | null | undefined)?.results as { local?: unknown } | null | undefined)?.local, 'scale-13k': priorStep('scale-13k'), 'scale-26k': priorStep('scale-26k') };
    classifications.push(...classifyCrossGroup(scaleGroup, priorScaleGroup, { requireIdentity: true }));
    classifications.push(...watchSanityGroup(scaleGroup));
  }

  const stressJson = loadCurrent('stress');
  if (stressJson) {
    classifications.push(...classifyCrossGroup({ stress: stressJson }, { stress: priorStep('stress') }, { requireIdentity: true }));
    classifications.push(...watchSanityGroup({ stress: stressJson }));
  }

  for (const store of OFFERED.filter((s) => s !== DEFAULT_STORE)) {
    const group: Record<string, unknown> = {};
    for (const size of ['hub', '13k', '26k']) {
      const id = `battery-${store}-${size}`;
      const j = loadCurrent(id);
      if (j) {
        group[id] = j;
      }
    }
    if (Object.keys(group).length > 0) {
      const priorGroup = Object.fromEntries(Object.keys(group).map((id) => [id, priorStep(id)]));
      classifications.push(...classifyCrossGroup(group, priorGroup, { requireIdentity: true }));
      classifications.push(...watchSanityGroup(group));
    }
    const stressId = `battery-${store}-stress`;
    const sj = loadCurrent(stressId);
    if (sj) {
      classifications.push(...classifyCrossGroup({ [stressId]: sj }, { [stressId]: priorStep(stressId) }, { requireIdentity: true }));
      classifications.push(...watchSanityGroup({ [stressId]: sj }));
    }
  }

  const retrievalOwed = !!(sitting as { owed: Record<string, unknown> | null | undefined }).owed?.fever;
  const evalIds = ['eval-nfcorpus', 'eval-fever'];
  for (const id of evalIds) {
    const j = loadQuality(id);
    if (j) {
      classifications.push(...classifyEval(id, j, priorStep(id), retrievalOwed, { requireIdentity: true }));
    }
  }
  // Portable quality is a relevance track, not a timing row. Each store gets the same corpus,
  // qrels, k, and bare-and query form; the comparison artifact is a fail-closed identity and
  // coverage check. A new track has no compatible historical prior and therefore reports
  // `no-compatible-prior` until the maintainer deliberately records one.
  for (const corpus of ['nfcorpus', 'fever']) {
    const portableRetrievalOwed = corpus === 'fever' ? !!(sitting as { owed: Record<string, unknown> | null | undefined }).owed?.fever : !!(sitting as { owed: Record<string, unknown> | null | undefined }).owed?.['quality-baseline'];
    const artifacts = PORTABLE_QUALITY_STORES.map((store) => loadQuality(`portable-eval-${corpus}-${store}`)).filter(Boolean);
    const comparisonId = `portable-eval-${corpus}-comparison`;
    const comparison = loadQuality(comparisonId);
    const persistedComparison = comparison ?? steps[comparisonId];
    if (persistedComparison) {
      if (retainedArtifacts[comparisonId]) verified.add(comparisonId);
      else {
        const recomputed = comparePortableQualityArtifacts(artifacts);
        if (!recomputed.valid || identityHash(recomputed) !== identityHash(persistedComparison)) invalidArtifact(comparisonId, `${comparisonId}: recomputation from retained inputs is invalid: ${recomputed.errors.join('; ') || 'persisted comparison disagrees with source artifacts'}`);
        else if (comparison) verified.add(comparisonId);
      }
    }
    for (const store of PORTABLE_QUALITY_STORES) {
      const id = `portable-eval-${corpus}-${store}`;
      const artifact = loadQuality(id);
      if (artifact) classifications.push(...classifyEval(id, artifact, priorStep(id), portableRetrievalOwed, { requireIdentity: true }));
    }
  }

  // Successful out steps must leave their declared artifact. Store-dump and oracle use distinct
  // payloads, so this check only requires their presence.
  for (const id of expectedArtifacts) {
    if (!(sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id] || !['ok', 'failed', ...HISTORICAL_FAILED_STATUSES].includes(((sitting as { steps: Record<string, unknown> }).steps[id] as { status: string }).status)) continue;
    const path = join(sittingDir, `${id}.json`);
    if (existsSync(path)) continue;
    const reason = `${id}: recorded successful step has no current artifact`;
    steps[id] = { error: reason };
    invalidArtifact(id, reason);
  }

  return { classifications, steps, verified, priorFrom, priorHarnessMismatch, retainedQuality: retainedQualityErrors.length === 0 && verified.has('retained-quality') ? retainedQuality : null, retainedQualityErrors };
}

// notes and largest note size per measured context: properties of the corpus, not measurements of
// sensemaking, so they sit in the report header rather than gating as timing rows.
function corpusShape(steps: Record<string, unknown>) {
  const shape: Record<string, { notes: number; largest_note_tokens: unknown }> = {};
  for (const [id, step] of Object.entries(steps)) {
    // compare.json wraps one run row per version; every other step's JSON is the row itself.
    const row = (step as { results?: Record<string, unknown> } | null | undefined)?.results ? (step as { results: Record<string, unknown> }).results[(step as { versions: string[] }).versions?.[1]] : step;
    if (typeof (row as { notes?: unknown } | null | undefined)?.notes !== 'number') continue;
    shape[id === 'compare' ? 'hub' : id] = { notes: (row as { notes: number }).notes, largest_note_tokens: (row as { largest_note_tokens: unknown }).largest_note_tokens ?? null };
  }
  return shape;
}

const CONTEXT_SLUG = (context: string) => context.replace(/[-/]/g, '_');

// The fixed context list, independent of what any one sitting measures. Frontmatter carries a key
// per (context, record row) pair from it, null where unmeasured, never an absent key.
const DEFAULT_CONTEXTS = ['hub', 'scale-13k', 'scale-26k', 'stress'];
const BATTERY_CONTEXTS = OFFERED.filter((s) => s !== DEFAULT_STORE).flatMap((store) => ['hub', '13k', '26k', 'stress'].map((size) => `battery-${store}-${size}`));
const EVAL_CONTEXTS = ['eval-nfcorpus', 'eval-fever'];
const TIMING_RECORD_ROWS = ROWS.filter((r) => r.record && (r.kind === 'wall' || r.kind === 'inproc' || r.kind === 'tokens'));
const QUALITY_RECORD_ROWS = ROWS.filter((r) => r.record && r.kind === 'quality');

export function recordFields(classifications: readonly Classification[]) {
  const byId = new Map(classifications.map((c) => [c.id, c]));
  const fields: Record<string, unknown> = {};
  for (const context of [...DEFAULT_CONTEXTS, ...BATTERY_CONTEXTS]) {
    for (const row of TIMING_RECORD_ROWS) fields[`${CONTEXT_SLUG(context)}_${row.key.replace(/\./g, '_')}`] = byId.get(`${context}/${row.key}`)?.current ?? null;
  }
  for (const context of EVAL_CONTEXTS) {
    // 4 decimals is the precision these metrics are read and compared at; a raw float prints 16
    // digits of noise nobody uses.
    for (const row of QUALITY_RECORD_ROWS) {
      const v = byId.get(`${context}/semantic/${row.key}`)?.current;
      fields[`${CONTEXT_SLUG(context)}_${row.key}`] = typeof v === 'number' ? Number(v.toFixed(4)) : (v ?? null);
    }
  }
  return fields;
}

// The report this sitting already rendered, if any: its accepted rows and release version carry forward.
const existingSittingReport = (sittingDir: string) => readJson(join(sittingDir, `${SITTING_REPORT}.json`));

const fixedRange = (samples: readonly unknown[]) => {
  const values = samples.filter((value) => Number.isFinite(value));
  return values.length === samples.length && values.length > 0 ? `${Math.min(...(values as number[])).toFixed(3)} to ${Math.max(...(values as number[])).toFixed(3)} ms` : 'invalid';
};

// How a timing taken with an exit reading above the admission limit is labelled: an observation of a
// loaded machine (the workload included), not evidence of contention and not a clean comparison.
const ELEVATED_EXIT = 'exit load above the admission limit, an observation and not a clean comparison';

const fixedCostRows = (report: { steps?: Record<string, unknown> }) => {
  const shared = (report as { steps: Record<string, unknown> | null | undefined }).steps?.['shared-snippet'];
  const hydration = (report as { steps: Record<string, unknown> | null | undefined }).steps?.['native-hydration-comparison'];
  const sharedRows =
    (shared as { valid?: unknown } | null | undefined)?.valid === true && Array.isArray((shared as { samples: unknown[] }).samples)
      ? [
          [
            'shared snippet and line work',
            String((shared as { samples: unknown[] }).samples.length),
            fixedRange((shared as { samples: unknown[] }).samples.map((sample) => (sample as { ms: unknown }).ms)),
            `${(shared as { median_ms: { toFixed: (digits: number) => string } }).median_ms.toFixed(3)} ms`,
            exitAboveAdmissionLimit(shared) ? `once for the fixed files and caller budgets; ${ELEVATED_EXIT}` : 'once for the fixed files and caller budgets',
          ],
        ]
      : [];
  const hydrationRows =
    (hydration as { valid?: unknown } | null | undefined)?.valid === true && (hydration as { samples_ms_by_store?: Record<string, unknown[]> } | null | undefined)?.samples_ms_by_store && (hydration as { median_ms_by_store?: Record<string, number> } | null | undefined)?.median_ms_by_store
      ? Object.entries((hydration as { samples_ms_by_store: Record<string, unknown[]> }).samples_ms_by_store)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([store, samples]) => {
            const median = (hydration as { median_ms_by_store: Record<string, number> }).median_ms_by_store[store];
            const fastest = Math.min(...Object.values((hydration as { median_ms_by_store: Record<string, number> }).median_ms_by_store));
            // No ratio when any store's exit reading was above the admission limit: not a clean comparison.
            const elevated = (hydration as { exit_load_above_admission_limit?: string[] }).exit_load_above_admission_limit;
            return [store, String(samples.length), fixedRange(samples), `${median.toFixed(3)} ms`, elevated ? `not compared: ${ELEVATED_EXIT} (${elevated.join(', ')})` : `${(median / fastest).toFixed(2)}× fastest`];
          })
      : [];
  return { sharedRows, hydrationRows, scope: (hydration as { scope?: unknown } | null | undefined)?.scope ?? null };
};

function storeForContext(context: string, steps: Record<string, unknown>) {
  const base = context.split('/')[0];
  const battery = /^battery-(sqlite|duckdb|turso)-/.exec(base);
  if (battery) return battery[1];
  const portable = /^portable-eval-[^-]+-(sqlite|duckdb|turso)$/.exec(base);
  if (portable) return portable[1];
  const step = steps[base === 'hub' ? 'compare' : base];
  if (typeof (step as { store?: unknown } | null | undefined)?.store === 'string') return (step as { store: unknown }).store;
  if (typeof ((step as { results?: Record<string, unknown> } | null | undefined)?.results?.[(step as { versions: string[] }).versions?.[1]] as { store?: unknown } | null | undefined)?.store === 'string')
    return ((step as { results: Record<string, unknown> }).results[(step as { versions: string[] }).versions[1]] as { store: unknown }).store;
  return null;
}

const compatibleNumeric = (classification: Pick<Classification, 'invalid' | 'prior' | 'current' | 'verdict'>) => classification.invalid !== true && Number.isFinite(classification.prior) && Number.isFinite(classification.current) && classification.verdict !== 'no-compatible-prior';

export function comparisonCounts(classifications: readonly Pick<Classification, 'invalid' | 'prior' | 'current' | 'verdict'>[]) {
  const valid = classifications.filter(compatibleNumeric).length;
  const invalid = classifications.filter((classification) => classification.invalid === true).length;
  const notCompared = classifications.length - valid - invalid;
  return { valid, invalid, notCompared };
}

function historicalRows(classifications: readonly Classification[], steps: Record<string, unknown>, kind: string) {
  return classifications
    .filter((classification) => ROW_BY_KEY.get(classification.key)?.kind === kind && compatibleNumeric(classification))
    .map((classification) => {
      const ratio = classification.prior === 0 ? 'n/a' : `${((classification.current as number) / (classification.prior as number)).toFixed(2)}×`;
      const delta = (classification.current as number) - (classification.prior as number);
      const unit = ROW_BY_KEY.get(classification.key)?.kind === 'tokens' ? 'estimated tokens' : ROW_BY_KEY.get(classification.key)?.kind === 'quality' ? 'score' : 'ms';
      return [storeForContext(classification.context, steps) ?? 'unknown', classification.context, classification.variant ?? '—', classification.key, unit, String(classification.prior), String(classification.current), String(delta), ratio, classification.verdict, classification.severity];
    })
    .sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

function nativeSelectedDiagnosticRows(classifications: readonly Classification[], steps: Record<string, unknown>) {
  return classifications
    .filter((classification) => {
      const row = ROW_BY_KEY.get(classification.key);
      return row && row.comparison_class === 'native-diagnostic' && ['wall', 'inproc', 'total'].includes(row.kind) && classification.invalid !== true && Number.isFinite(classification.current) && storeForContext(classification.context, steps) !== null;
    })
    .map((classification) => [storeForContext(classification.context, steps), classification.context, classification.key, `${classification.current} ms`])
    .sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

function currentQualityRows(steps: Record<string, unknown>, verified: ReadonlySet<string>) {
  const rows = [];
  for (const [id, artifact] of Object.entries(steps)) {
    const store = /^portable-eval-[^-]+-(sqlite|duckdb|turso)$/.exec(id)?.[1];
    const corpus = /^portable-eval-([^-]+)-(sqlite|duckdb|turso)$/.exec(id)?.[1];
    const _comparison = corpus ? steps[`portable-eval-${corpus}-comparison`] : null;
    if (!store || !verified.has(`portable-eval-${corpus}-comparison`)) continue;
    for (const [variant, values] of Object.entries((artifact as { variants: Record<string, unknown> | null | undefined }).variants ?? {})) {
      for (const key of ['ndcg', 'rr', 'hit']) if (Number.isFinite((values as Record<string, unknown> | null | undefined)?.[key])) rows.push([store, id.replace(`-${store}`, ''), variant, key, ((values as Record<string, unknown>)[key] as { toFixed: (digits: number) => string }).toFixed(4)]);
    }
  }
  return rows.sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

function readNativeMatrix(nativeMatrixPath: string | null) {
  if (!nativeMatrixPath) return { rows: [], error: null };
  try {
    const matrix = readJson(nativeMatrixPath);
    if ((matrix as { schema?: unknown } | null | undefined)?.schema !== 'native-evidence-matrix-v1' || (matrix as { status: unknown }).status !== 'success' || (matrix as { valid: unknown }).valid !== true || !Array.isArray((matrix as { records: unknown[] }).records))
      throw new Error('matrix does not record a successful native-evidence-matrix-v1 run');
    const root = dirname(nativeMatrixPath);
    const resolveArtifact = (path: string, folder: string) => {
      const direct = isAbsolute(path) ? path : resolve(root, path);
      if (existsSync(direct)) return direct;
      const relocated = join(root, folder, basename(path));
      if (resolve(relocated).startsWith(`${resolve(root)}${process.platform === 'win32' ? '\\' : '/'}`) && existsSync(relocated)) return relocated;
      throw new Error(`retained ${folder} artifact is missing: ${path}`);
    };
    const plan = nativeEvidenceExecutionPlan((matrix as { second_baseline_notes: number }).second_baseline_notes).comparators;
    const recordKey = (record: unknown) =>
      (record as { kind: unknown }).kind === 'native-capability'
        ? `${(record as { kind: unknown }).kind}\0${(record as { case_id: unknown }).case_id}\0${(record as { notes: unknown }).notes}`
        : `${(record as { kind: unknown }).kind}\0${(record as { changed: unknown }).changed}\0${(record as { notes: unknown }).notes}`;
    if (identityHash((matrix as { records: unknown[] }).records.map(recordKey).sort()) !== identityHash(plan.map(recordKey).sort())) throw new Error('native matrix coverage differs from the expected capability and update groups');
    const rows = [];
    const raw = [];
    for (const record of (matrix as { records: unknown[] }).records.filter((entry) => (entry as { kind: unknown }).kind === 'native-capability')) {
      if (!Array.isArray((record as { artifacts: unknown[] }).artifacts) || typeof (record as { comparison: unknown }).comparison !== 'string') throw new Error(`native capability ${(record as { case_id: unknown }).case_id ?? 'unknown'} has incomplete paths`);
      const artifacts = (record as { artifacts: unknown[] }).artifacts.map((path) => readJson(resolveArtifact(path as string, 'native-capability')));
      if (artifacts.some((artifact) => (artifact as { case_id?: unknown } | null | undefined)?.case_id !== (record as { case_id: unknown }).case_id || (artifact as { notes?: unknown } | null | undefined)?.notes !== (record as { notes: unknown }).notes))
        throw new Error(`native capability ${(record as { case_id: unknown }).case_id}: record label disagrees with source workload`);
      const comparison = readJson(resolveArtifact((record as { comparison: string }).comparison, 'native-capability'));
      const recomputed = compareNativeCapabilityArtifacts(artifacts);
      if (!recomputed.eligible || identityHash(recomputed) !== identityHash(comparison)) throw new Error(`native capability ${(record as { case_id: unknown }).case_id}: persisted comparison disagrees with validated source artifacts`);
      raw.push({
        case_id: (record as { case_id: unknown }).case_id,
        notes: (record as { notes: unknown }).notes,
        comparison: recomputed,
        provenance_by_store: Object.fromEntries(
          artifacts.map((artifact) => [
            (artifact as { store: unknown }).store,
            {
              measured_package: ((artifact as { provenance: unknown }).provenance as { measured_package: unknown }).measured_package,
              runtime: ((artifact as { provenance: unknown }).provenance as { runtime: unknown }).runtime,
              harness: ((artifact as { provenance: unknown }).provenance as { harness: unknown }).harness,
            },
          ])
        ),
      });
      for (const [capability, values] of Object.entries(recomputed.common_rows)) {
        const medians = (values as { median_ms_by_store: Record<string, number> }).median_ms_by_store;
        const fastest = Math.min(...Object.values(medians));
        rows.push([
          (record as { case_id: unknown }).case_id,
          String((record as { notes: unknown }).notes),
          capability,
          ...Object.entries(medians)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([store, median]) => {
              const samples = (values as { samples_ms_by_store: Record<string, unknown[]> }).samples_ms_by_store[store];
              const elevated = (recomputed as { exit_load_above_admission_limit?: string[] }).exit_load_above_admission_limit;
              return `${store} n=${samples.length}, ${Math.min(...(samples as number[])).toFixed(3)}–${Math.max(...(samples as number[])).toFixed(3)} ms, median ${median.toFixed(3)} ms (${elevated ? `not compared: ${ELEVATED_EXIT} (${elevated.join(', ')})` : `${(median / fastest).toFixed(2)}×`})`;
            }),
        ]);
      }
    }
    const updates = [];
    for (const record of (matrix as { records: unknown[] }).records.filter((entry) => (entry as { kind: unknown }).kind === 'native-update')) {
      if (!Array.isArray((record as { artifacts: unknown[] }).artifacts) || typeof (record as { comparison: unknown }).comparison !== 'string') throw new Error(`native update ${(record as { changed: unknown }).changed ?? 'unknown'} has incomplete paths`);
      const artifacts = (record as { artifacts: unknown[] }).artifacts.map((path) => readJson(resolveArtifact(path as string, 'native-update')));
      if (artifacts.some((artifact) => (artifact as { changed?: unknown } | null | undefined)?.changed !== (record as { changed: unknown }).changed || ((artifact as { expected?: unknown } | null | undefined)?.expected as { notes?: unknown } | null | undefined)?.notes !== (record as { notes: unknown }).notes))
        throw new Error(`native update ${(record as { changed: unknown }).changed}: record label disagrees with source workload`);
      const comparison = readJson(resolveArtifact((record as { comparison: string }).comparison, 'native-update'));
      const recomputed = compareNativeUpdateArtifacts(artifacts);
      if (!recomputed.valid || identityHash(recomputed) !== identityHash(comparison)) throw new Error(`native update ${(record as { changed: unknown }).changed}: persisted comparison disagrees with validated source artifacts`);
      updates.push({
        changed: (record as { changed: unknown }).changed,
        notes: (record as { notes: unknown }).notes,
        comparison: recomputed,
        provenance_by_store: Object.fromEntries(
          artifacts.map((artifact) => [
            (artifact as { store: unknown }).store,
            {
              measured_package: ((artifact as { provenance: unknown }).provenance as { measured_package: unknown }).measured_package,
              runtime: ((artifact as { provenance: unknown }).provenance as { runtime: unknown }).runtime,
              harness: ((artifact as { provenance: unknown }).provenance as { harness: unknown }).harness,
            },
          ])
        ),
      });
    }
    return { rows, raw, updates, update_coverage: `${updates.length} validated native-update groups`, error: null };
  } catch (error) {
    return { rows: [], raw: [], updates: [], update_coverage: 'not rendered', error: (error as { message?: unknown } | null | undefined)?.message ?? String(error) };
  }
}

function historyCoverage(classifications: readonly Classification[], steps: Record<string, unknown>) {
  const grouped = new Map<string, { valid: number; invalid: number; notCompared: number }>();
  for (const classification of classifications) {
    if (!ROW_BY_KEY.has(classification.key)) continue;
    const key = `${storeForContext(classification.context, steps) ?? 'unknown'}\0${classification.key}`;
    const counts = grouped.get(key) ?? { valid: 0, invalid: 0, notCompared: 0 };
    if (compatibleNumeric(classification)) counts.valid++;
    else if (classification.invalid === true) counts.invalid++;
    else counts.notCompared++;
    grouped.set(key, counts);
  }
  return [...grouped.entries()].map(([key, counts]) => [...key.split('\0'), String(counts.valid), String(counts.invalid), String(counts.notCompared)]).sort((a, b) => a.join('\0').localeCompare(b.join('\0')));
}

function assessmentViews(steps: Record<string, unknown>, classifications: readonly Classification[], verified = new Set<string>(), nativeMatrixPath: string | null = null) {
  const fixed = fixedCostRows({
    steps: {
      'shared-snippet': verified.has('shared-snippet') ? steps['shared-snippet'] : null,
      'native-hydration-comparison': verified.has('native-hydration-comparison') ? steps['native-hydration-comparison'] : null,
    },
  });
  return {
    verified_artifacts: [...verified].sort(),
    comparison_counts: comparisonCounts(classifications),
    current_fixed_work: { shared: fixed.sharedRows, hydration: fixed.hydrationRows, scope: fixed.scope },
    current_common_query_relevance: currentQualityRows(steps, verified),
    current_native_capabilities: readNativeMatrix(nativeMatrixPath),
    native_selected_diagnostics: nativeSelectedDiagnosticRows(classifications, steps),
    compatible_history: {
      timing: historicalRows(classifications, steps, 'wall').concat(historicalRows(classifications, steps, 'inproc'), historicalRows(classifications, steps, 'total'), historicalRows(classifications, steps, 'tokens')),
      quality: historicalRows(classifications, steps, 'quality'),
      coverage: historyCoverage(classifications, steps),
    },
  };
}

export function renderMarkdown(report: unknown) {
  const lines = [];
  lines.push(`### ${(report as { date: unknown }).date}: release gate`);
  lines.push('');
  // Preserve the saved command label for byte-for-byte historical report rendering.
  lines.push(
    `\`node benchmark/gate.mjs\`, ${(report as { machine: unknown }).machine ?? 'unknown machine'}, Node ${(report as { node: unknown }).node ?? 'unknown'}. Baseline: ${(report as { package_version: unknown }).package_version ?? 'unknown'}. Last tag: ${(report as { last_tag: unknown }).last_tag ?? 'unknown'}.`
  );
  lines.push('');
  lines.push(`#### Verdict: ${(report as { verdict: unknown }).verdict}`);
  lines.push('');
  if ((report as { verdict_reasons: unknown[] }).verdict_reasons.length === 0) {
    lines.push('No BLOCK reason.');
  } else {
    for (const reason of (report as { verdict_reasons: unknown[] }).verdict_reasons) lines.push(`- ${reason}`);
  }
  lines.push('');
  lines.push('A moved row localizes a cost; it does not identify its mechanism. Settling the mechanism means removing the suspected cause and re-measuring, or timing it directly -- never reading it off the delta.');
  lines.push('');
  lines.push('A comparison class describes the workload or output. It does not by itself establish cross-store eligibility; workload identity, readiness, and output preflight remain separate requirements.');
  lines.push('');
  lines.push('#### Comparison classes');
  lines.push('');
  const comparisonClasses = (report as { comparison_classes: Record<string, unknown> | null | undefined }).comparison_classes ?? { unrecorded: 'This saved artifact did not record comparison-class definitions.' };
  for (const [name, description] of Object.entries(comparisonClasses)) lines.push(`- ${name}: ${description}`);
  lines.push('');
  const noise = (report as { classifications: Classification[] }).classifications.filter((c) => c.verdict === 'noise' || c.verdict === 'flat');
  if (noise.length > 0) {
    lines.push('#### Moved inside band, judged noise');
    lines.push('');
    for (const c of noise.filter((c) => c.verdict === 'noise')) lines.push(`- ${c.reason}`);
    lines.push('');
  }
  const faster = (report as { classifications: Classification[] }).classifications.filter((c) => c.verdict === 'faster');
  if (faster.length > 0) {
    lines.push('#### Faster than band, never blocking');
    lines.push('');
    for (const c of faster) lines.push(`- ${c.reason}`);
    lines.push('');
  }
  if (Object.keys((report as { accepted: AcceptanceEntries }).accepted).length > 0) {
    lines.push('#### Owner decisions');
    lines.push('');
    const stageReasons = new Set((report as { stage_reasons: string[] | null | undefined }).stage_reasons ?? []);
    for (const [id, { reason, date }] of Object.entries((report as { accepted: AcceptanceEntries }).accepted)) lines.push(`- ${stageReasons.has(id) ? 'stage ' : ''}${id}: owner decision, ${date}: ${reason}`);
    lines.push('');
  }
  if (Object.keys((report as { stale_acceptances: AcceptanceEntries }).stale_acceptances ?? {}).length > 0) {
    lines.push('', '### Stale acceptances', '', 'These decisions do not match the current measurement evidence and were not applied.', '');
    for (const [id, { reason, date }] of Object.entries((report as { stale_acceptances: AcceptanceEntries }).stale_acceptances)) lines.push(`- ${id}: ${date}: ${reason}`);
  }
  if ((report as { changelog_entry: unknown }).changelog_entry) {
    lines.push('#### What this sitting gates');
    lines.push('');
    lines.push((report as { changelog_entry: unknown }).changelog_entry);
    lines.push('');
  }
  lines.push('#### Run summary');
  lines.push('');
  lines.push(
    `- provenance: last tag \`${(report as { last_tag: unknown }).last_tag ?? 'unknown'}\`, package version ${(report as { package_version: unknown }).package_version ?? 'unknown'}, ${(report as { changed_paths: { length: number } | null | undefined }).changed_paths?.length ?? 0} changed path(s) read to decide what was owed (no commit hash: RELEASING.md's rule, since a rebase or squash can orphan one)`
  );
  if ((report as { profile: unknown }).profile != null) lines.push(`- profile: ${(report as { profile: unknown }).profile}`);
  if ((report as { quality_scope: unknown }).quality_scope === QUALITY_SCOPE) lines.push('- quality scope: portable corpora; SQLite OR-bag relevance is not required by this assessment. Any separately collected OR-bag evidence is validated.');
  lines.push(`- owed: ${Object.keys((report as { owed: Record<string, unknown> | null | undefined }).owed ?? {}).length > 0 ? Object.keys((report as { owed: Record<string, unknown> }).owed).join(', ') : 'nothing beyond the always-owed stages'}`);
  if ((report as { retained_quality: unknown }).retained_quality)
    lines.push(
      `- retained quality: ${((report as { retained_quality: unknown }).retained_quality as { status: unknown }).status}${((report as { retained_quality: unknown }).retained_quality as { source: unknown }).source ? ` from ${(((report as { retained_quality: unknown }).retained_quality as { source: unknown }).source as { report: unknown }).report} (${(((report as { retained_quality: unknown }).retained_quality as { source: unknown }).source as { sitting: unknown }).sitting})` : ''}`
    );
  if (((report as { retained_quality: unknown }).retained_quality as { valid?: unknown } | null | undefined)?.valid === true) {
    const { source, scope } = (report as { retained_quality: { source?: unknown; scope?: unknown } }).retained_quality;
    lines.push(
      `- retained measurements: package ${(source as { package_version?: unknown } | null | undefined)?.package_version ?? 'unknown'}, ${(scope as { corpus?: unknown } | null | undefined)?.corpus ?? 'unknown corpus'}/${(scope as { query_form?: unknown } | null | undefined)?.query_form ?? 'unknown query form'}, split ${(scope as { split?: unknown } | null | undefined)?.split ?? 'unknown'}, k=${(scope as { k?: unknown } | null | undefined)?.k ?? 'unknown'}, on ${((scope as { stores?: unknown[] } | null | undefined)?.stores ?? []).join(', ')}. Quality metrics were recomputed from the original rankings; this retained-quality step did not rerun search or measure timing.`
    );
  }
  lines.push(
    `- ran: ${Object.values((report as { steps_status: Record<string, unknown> | null | undefined }).steps_status ?? {}).filter((s) => (s as { status?: unknown } | null | undefined)?.status === 'ok').length} step(s) ok, ${Object.values((report as { steps_status: Record<string, unknown> | null | undefined }).steps_status ?? {}).filter((s) => (s as { status?: unknown } | null | undefined)?.status === 'not-owed').length} not owed, ${Object.values((report as { steps_status: Record<string, unknown> | null | undefined }).steps_status ?? {}).filter((s) => (s as { status?: unknown } | null | undefined)?.status === 'owed-unmet').length} owed-unmet`
  );
  const assessment = (report as { assessment: ReturnType<typeof assessmentViews> | null | undefined }).assessment ?? assessmentViews((report as { steps: Record<string, unknown> | null | undefined }).steps ?? {}, (report as { classifications: Classification[] }).classifications);
  const counts = assessment.comparison_counts;
  lines.push(`- comparisons: ${counts.valid} valid numeric, ${counts.invalid} invalid, ${counts.notCompared} not compared`);
  const priorFrom = Object.entries((report as { prior_from: Record<string, unknown> | null | undefined }).prior_from ?? {});
  if (priorFrom.length > 0) lines.push(`- priors read from: ${[...new Set(priorFrom.map(([, from]) => from))].sort().join(', ')}`);
  const mismatchIds = Object.keys((report as { prior_harness_mismatch: Record<string, unknown> | null | undefined }).prior_harness_mismatch ?? {});
  if (mismatchIds.length > 0) lines.push(`- ${mismatchIds.length} step(s) had a prior measured by a different harness version and were not compared: ${mismatchIds.join(', ')}`);
  lines.push('');

  const resultSetRows = [];
  const verifiedArtifacts = new Set(assessment.verified_artifacts ?? []);
  for (const id of ['result-sets-hub', 'result-sets-stress']) {
    if (!verifiedArtifacts.has(id)) continue;
    const artifact = (report as { steps: Record<string, unknown> | null | undefined }).steps?.[id];
    for (const [corpusName, corpus] of Object.entries((artifact as { corpora?: Record<string, unknown> | null | undefined } | null | undefined)?.corpora ?? {})) {
      for (const [query, pairs] of Object.entries((corpus as { overlap?: Record<string, unknown> | null | undefined } | null | undefined)?.overlap ?? {})) {
        for (const [stores, overlap] of Object.entries(pairs ?? {})) {
          if (
            !overlap ||
            typeof overlap !== 'object' ||
            !Number.isSafeInteger((overlap as { shared_paths: unknown }).shared_paths) ||
            !Number.isSafeInteger((overlap as { union_paths: unknown }).union_paths) ||
            !Number.isFinite((overlap as { jaccard_path: unknown }).jaccard_path) ||
            typeof (overlap as { top1_same: unknown }).top1_same !== 'boolean'
          )
            continue;
          resultSetRows.push([
            id,
            corpusName,
            query,
            stores.replace('|', ' / '),
            `${(overlap as { shared_paths: unknown }).shared_paths}/${(overlap as { union_paths: unknown }).union_paths}`,
            Number((overlap as { jaccard_path: unknown }).jaccard_path).toFixed(3),
            (overlap as { top1_same: unknown }).top1_same ? 'yes' : 'no',
          ]);
        }
      }
    }
  }
  if (resultSetRows.length > 0) {
    lines.push('#### Ranked result-set overlap');
    lines.push('');
    lines.push('Descriptive evidence only: qrels and authored fixtures decide correctness; these path differences show when native stores selected different downstream work.');
    lines.push('');
    lines.push(mdTable(['stage', 'corpus', 'query', 'stores', 'shared/union', 'Jaccard', 'same top-1'], resultSetRows));
    lines.push('');
  }

  const fixed = assessment.current_fixed_work;
  lines.push('#### Current fixed-work cross-store costs');
  lines.push('');
  lines.push('These measurements use validated common files, ordered candidates, output preflight, readiness, and harness identity. Implementation provenance records what ran. It does not decide logical-work compatibility.');
  lines.push('');
  if (fixed.shared.length > 0) {
    lines.push('Shared work is measured once, outside the store comparison.');
    lines.push('');
    lines.push(mdTable(['shared work', 'samples', 'range', 'median', 'scope'], fixed.shared));
    lines.push('');
  }
  if (fixed.hydration.length > 0) {
    lines.push(fixed.scope ?? 'Production hydration over fixed ordered candidates.');
    lines.push('');
    lines.push(mdTable(['store', 'samples', 'range', 'median', 'ratio'], fixed.hydration));
    lines.push('');
  } else {
    lines.push('No valid three-store fixed-work hydration comparison was recorded.');
    lines.push('');
  }

  const nativeCapabilities = assessment.current_native_capabilities;
  if (nativeCapabilities?.rows.length > 0) {
    lines.push('#### Attached native-capability costs');
    lines.push('');
    lines.push(
      "These are validated three-store native-operation diagnostics from the attached matrix on each named common fixture. Its implementation provenance is retained in the JSON view; it is separate evidence and is not inferred to be the sitting's current tree. Ratios describe medians only and make no significance claim."
    );
    lines.push('');
    lines.push(
      mdTable(
        ['case', 'notes', 'capability', 'store medians and ratios'],
        nativeCapabilities.rows.map((row) => [row[0], row[1], row[2], row.slice(3).join('; ')])
      )
    );
    lines.push('');
  } else if (nativeCapabilities?.error) {
    lines.push('#### Attached native-capability costs');
    lines.push('');
    lines.push(`No validated native matrix was used: ${nativeCapabilities.error}`);
    lines.push('');
  }

  const nativeDiagnostics = assessment.native_selected_diagnostics;
  if (nativeDiagnostics.length > 0) {
    lines.push('#### Native-selected end-to-end diagnostics');
    lines.push('');
    lines.push("These rows retain each store's selected path and must not be read as fixed-work cross-store costs.");
    lines.push('');
    lines.push(mdTable(['store', 'context', 'capability', 'current'], nativeDiagnostics));
    lines.push('');
  }

  const timingHistory = assessment.compatible_history.timing;
  if (timingHistory.length > 0) {
    lines.push('#### Compatible history by store');
    lines.push('');
    lines.push('Only rows with valid numeric readings on matching logical work appear here. A changed workload or missing prior starts a new series and is counted above, not hidden in this table.');
    lines.push('');
    lines.push(mdTable(['store', 'context', 'variant', 'capability', 'unit', 'prior', 'current', 'delta', 'ratio', 'observation', 'severity'], timingHistory));
    lines.push('');
  }
  const qualityHistory = assessment.compatible_history.quality;
  if (qualityHistory.length > 0) {
    lines.push('#### Compatible common-query relevance history');
    lines.push('');
    lines.push('Relevance is separate from latency. It compares the recorded common queries and qrels, not a store-selected timing path.');
    lines.push('');
    lines.push(mdTable(['store', 'context', 'variant', 'metric', 'unit', 'prior', 'current', 'delta', 'ratio', 'observation', 'severity'], qualityHistory));
    lines.push('');
  }
  if (assessment.compatible_history.coverage.length > 0) {
    lines.push('#### Historical comparison coverage');
    lines.push('');
    lines.push(mdTable(['store', 'capability', 'valid numeric', 'invalid', 'not compared'], assessment.compatible_history.coverage));
    lines.push('');
  }
  if (assessment.current_common_query_relevance.length > 0) {
    lines.push('#### Current common-query relevance');
    lines.push('');
    lines.push('These validated all-store results share a corpus, query form, qrels, and k. They are relevance evidence, not latency.');
    lines.push('');
    lines.push(mdTable(['store', 'corpus', 'variant', 'metric', 'current'], assessment.current_common_query_relevance));
    lines.push('');
  }

  const storeDump = verifiedArtifacts.has('store-dump') ? (report as { steps: Record<string, unknown> | null | undefined }).steps?.['store-dump'] : null;
  if ((storeDump as { capture_identity?: unknown } | null | undefined)?.capture_identity && ((storeDump as { diff: unknown }).diff as { categories?: Record<string, unknown> } | null | undefined)?.categories) {
    lines.push('#### Store-dump evidence', '');
    lines.push(
      `Before capture: \`${(((storeDump as { capture_identity: unknown }).capture_identity as { before: unknown }).before as { sha256?: unknown } | null | undefined)?.sha256 ?? 'missing'}\`; after capture: \`${(((storeDump as { capture_identity: unknown }).capture_identity as { after: unknown }).after as { sha256?: unknown } | null | undefined)?.sha256 ?? 'missing'}\`.`
    );
    lines.push('');
    if ((storeDump as { ok: unknown }).ok !== true) {
      lines.push('The capture is valid evidence of differences. Semantic review is required before any release severity can change.');
      lines.push('');
    }
    const diffRows = Object.entries(((storeDump as { diff: unknown }).diff as { categories: Record<string, unknown> }).categories).map(([category, entries]) => {
      const evidence = storeDumpCategoryEvidence(entries);
      return [category, String(evidence.count), evidence.diagnostics];
    });
    if (diffRows.length > 0) lines.push(mdTable(['difference', 'count', 'identities'], diffRows), '');
    else lines.push('No structured differences recorded.', '');
  }

  const grouped = new Map<string, Classification[]>();
  for (const c of (report as { classifications: Classification[] }).classifications) {
    if (!grouped.has(c.context)) grouped.set(c.context, []);
    (grouped.get(c.context) as Classification[]).push(c);
  }
  for (const [context, rows] of grouped) {
    lines.push(`#### ${context}`);
    lines.push('');
    lines.push(
      mdTable(
        ['row', 'class', 'prior', 'current', 'verdict', 'severity', 'reason'],
        rows.map((c) => [c.key, c.comparison_class ?? 'unrecorded', String(c.prior ?? '—'), String(c.current ?? '—'), c.verdict, c.severity ?? classificationSeverity(c), c.reason ?? '—'])
      )
    );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// The CHANGELOG section for the version this sitting gates. Read here, not in the gate: the gate
// runs before the entry is written, so only the --release re-render can see it.
export function changelogEntry(version: unknown, changelogPath = join(ROOT, 'CHANGELOG.md')) {
  if (!version || !existsSync(changelogPath)) return null;
  const md = readFileSync(changelogPath, 'utf8');
  const start = md.search(new RegExp(`^## \\[${(version as string).replace(/\./g, '\\.')}\\]`, 'm'));
  if (start < 0) return null;
  const rest = md.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

// A step whose log exists but whose status was never written started and was interrupted: the
// sitting measured nothing past it, so it cannot pass until it is resumed and finishes.
export function interruptedSteps(sittingDir: string, sitting: unknown) {
  return readdirSync(sittingDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => f.slice(0, -'.log'.length))
    .filter((id) => !((sitting as { steps: Record<string, unknown> | null | undefined }).steps?.[id] as { status?: unknown } | null | undefined)?.status)
    .map((id) => `${id}: started, never finished (sitting interrupted); run the gate again to resume it`);
}

// A step an earlier stage failure left unreached (gate.ts's not-run marker): unmeasured, the
// same kind of reason as interruptedSteps, never something a resume can silently pass.
export function unmeasuredSteps(sitting: unknown) {
  return Object.values((sitting as { steps: Record<string, unknown> | null | undefined }).steps ?? {})
    .filter((s) => (s as { status?: unknown } | null | undefined)?.status === 'not-run')
    .map((s) =>
      Array.isArray((s as { blocked_by: unknown }).blocked_by) && (s as { blocked_by: unknown[] }).blocked_by.length > 0
        ? `${(s as { id: unknown }).id}: not run (blocked by ${(s as { blocked_by: unknown[] }).blocked_by.join(', ')}); run the gate again to resume it`
        : `${(s as { id: unknown }).id}: not run (the gate stopped at an earlier failure); run the gate again to resume it`
    );
}

/** @param {string} sittingDir @param {{ reportsDir?: string, sittingsDir?: string, currentRoot?: string, releaseVersionOverride?: string, nativeMatrixPath?: string }} [opts] */
export function buildReport(sittingDir: string, { reportsDir = REPORTS_DIR, sittingsDir = SITTINGS_DIR, currentRoot = ROOT, releaseVersionOverride, nativeMatrixPath = null }: BuildOptions = {}) {
  const sitting: unknown = JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8'));
  const existing = existingSittingReport(sittingDir);
  const recordedAcceptances = { ...((existing as { accepted?: AcceptanceEntries } | null | undefined)?.accepted ?? {}), ...((existing as { stale_acceptances?: AcceptanceEntries } | null | undefined)?.stale_acceptances ?? {}) };

  const priorReports = findPriorReports(reportsDir, (sitting as { baseline_version: string | null | undefined }).baseline_version);
  let { classifications, steps, verified, priorFrom, priorHarnessMismatch, retainedQuality, retainedQualityErrors } = classifySitting(sittingDir, sitting, priorStepLookup(priorReports, MEASURE_VERSION), { reportsDir, sittingsDir, currentRoot });
  // stageReasons is the only thing --accept may ever name (a stage failure the owner can judge
  // and choose to ship past). unmeasured is a different kind of reason -- work the gate never
  // reached at all -- and blocks unconditionally: it is never in stage_reasons, so acceptRow can
  // never find it as an id, and no override can turn "this was not measured" into a pass.
  const stageReasons = failedStageReasons((sitting as { steps: Record<string, unknown> | null | undefined }).steps ?? {});
  const recordedStageReasons = (sitting as { failed_stage_reasons: unknown }).failed_stage_reasons ?? stageReasons;
  if (!Array.isArray(recordedStageReasons)) {
    classifications.push({
      id: 'coverage/stage-reasons',
      context: 'coverage',
      key: 'validity',
      verdict: 'failed',
      invalid: true,
      reason: 'coverage: recorded failed_stage_reasons is not an array',
      prior: null,
      current: null,
    });
  } else if (identityHash(recordedStageReasons) !== identityHash(stageReasons)) {
    classifications.push({
      id: 'coverage/stage-reasons',
      context: 'coverage',
      key: 'validity',
      verdict: 'failed',
      invalid: true,
      reason: `coverage: recorded failed_stage_reasons disagrees with step statuses (${recordedStageReasons.join(', ') || 'none'} vs ${stageReasons.join(', ') || 'none'})`,
      prior: null,
      current: null,
    });
  }
  classifications = withSeverity(classifications);
  const unmeasured = [...interruptedSteps(sittingDir, sitting), ...unmeasuredSteps(sitting)];
  const acceptanceView = {
    measure_version: MEASURE_VERSION,
    classifications,
    steps_status: (sitting as { steps: Record<string, unknown> | null | undefined }).steps ?? {},
    profile: (sitting as { profile: unknown }).profile,
    effective_requirements: (sitting as { effective_requirements: unknown }).effective_requirements ?? (sitting as { owed: Record<string, unknown> | null | undefined }).owed ?? {},
    retained_quality: (sitting as { retained_quality: unknown }).retained_quality ?? null,
  };
  const accepted = Object.fromEntries(Object.entries(recordedAcceptances).filter(([id, entry]) => acceptanceApplies(id, entry, acceptanceView, sittingDir)));
  const staleAcceptances = Object.fromEntries(Object.entries(recordedAcceptances).filter(([id, entry]) => !acceptanceApplies(id, entry, acceptanceView, sittingDir)));
  const { verdict, reasons } = aggregateVerdict(classifications, [...blockingStageReasons(stageReasons, accepted), ...unmeasured], accepted);

  const record = recordFields(classifications);

  return {
    date: (sitting as { date: unknown }).date,
    title: `${(sitting as { date: unknown }).date} release gate`,
    package_version: (sitting as { baseline_version: unknown }).baseline_version ?? null,
    release_version: releaseVersionOverride ?? (existing as { release_version?: unknown } | null | undefined)?.release_version ?? null,
    chunk_version: (sitting as { chunk_version: unknown }).chunk_version ?? null,
    schema_version: (sitting as { schema_version: unknown }).schema_version ?? null,
    machine: ((sitting as { machine: unknown }).machine as { cpu_model?: unknown } | null | undefined)?.cpu_model ?? null,
    node: (sitting as { node: unknown }).node ?? null,
    corpora: [
      ...new Set(
        Object.values(steps)
          .map((s) => (s as { corpus?: unknown } | null | undefined)?.corpus ?? (s as { tree?: unknown } | null | undefined)?.tree)
          .filter(Boolean)
      ),
    ],
    corpus_shape: corpusShape(steps),
    // eval.mjs's own --model default; eval.mjs's --out JSON does not record the model name it used.
    embed_model: Object.values(steps).some((s) => (s as { variants?: Record<string, unknown> | null | undefined } | null | undefined)?.variants?.semantic) ? 'minishlab/potion-retrieval-32M' : null,
    verdict,
    verdict_reasons: reasons,
    // Every stage failure this sitting recorded, accepted or not, so a failure stays in the record
    // across a resume and --accept has something to name.
    stage_reasons: stageReasons,
    // Work the gate never reached at all (interrupted or left not-run by an earlier failure).
    // Persisted separately from stage_reasons, never merged into it: acceptRow re-reads this
    // report rather than recomputing from the sitting, so without its own field these reasons
    // would vanish from the verdict the moment any row or stage got accepted.
    unmeasured_reasons: unmeasured,
    // Provenance is the last tag plus the paths the gate read, never a commit hash: a rebase or
    // squash orphans a hash, and it orphaned the one the 0.20.0 report cited.
    last_tag: (sitting as { last_tag: unknown }).last_tag ?? null,
    // Which sitting produced this, so a re-render reaches the same data rather than guessing
    // between two runs that share a date and a baseline.
    sitting: basename(sittingDir),
    // The harness that classified this. A later bump refuses these priors by name, so a report from
    // an older harness cannot re-render byte for byte and is not expected to.
    measure_version: MEASURE_VERSION,
    // Snapshot the meanings beside each classification. Replaying an old saved artifact must not
    // silently assign today's comparison semantics to rows that never recorded them.
    comparison_classes: COMPARISON_CLASSES,
    // Which earlier report supplied the prior for each step. A step absent here had no prior in
    // any earlier report, so its rows are a real no-prior rather than a lookup that missed.
    prior_from: priorFrom,
    // Steps whose only earlier report was measured by a different harness version: not compared,
    // so their rows read no-prior rather than a (possibly false) delta across harnesses.
    prior_harness_mismatch: priorHarnessMismatch,
    changed_paths: (sitting as { changed_paths: { length: number } | null | undefined }).changed_paths ?? [],
    untracked_paths: (sitting as { untracked_paths: unknown }).untracked_paths ?? [],
    profile: (sitting as { profile: unknown }).profile ?? null,
    ...((sitting as { quality_scope: unknown }).quality_scope !== undefined ? { quality_scope: (sitting as { quality_scope: unknown }).quality_scope } : {}),
    effective_requirements: (sitting as { effective_requirements: unknown }).effective_requirements ?? (sitting as { owed: Record<string, unknown> | null | undefined }).owed ?? {},
    estimated_cost: (sitting as { estimated_cost: unknown }).estimated_cost ?? null,
    retained_quality: retainedQuality
      ? compactRetainedQuality({
          ...((sitting as { retained_quality: unknown }).retained_quality as object | null | undefined),
          status: 'revalidated',
          valid: true,
          source: (retainedQuality as { source: unknown }).source,
          raw_evidence: (retainedQuality as { raw_evidence: unknown }).raw_evidence,
          source_compact: (retainedQuality as { source_compact: unknown }).source_compact,
          source_steps_status: (retainedQuality as { source_steps_status: unknown }).source_steps_status,
        })
      : retainedQualityErrors.length > 0
        ? { ...((sitting as { retained_quality: unknown }).retained_quality as object | null | undefined), status: 'invalid', valid: false, errors: retainedQualityErrors }
        : (sitting as { retained_quality: unknown }).retained_quality && ((sitting as { owed: Record<string, unknown> | null | undefined }).owed?.['quality-baseline'] || (sitting as { owed: Record<string, unknown> | null | undefined }).owed?.fever)
          ? { ...((sitting as { retained_quality: unknown }).retained_quality as object | null | undefined), status: 'superseded-by-fresh-quality', valid: false }
          : ((sitting as { retained_quality: unknown }).retained_quality ?? null),
    owed: (sitting as { owed: Record<string, unknown> | null | undefined }).owed ?? {},
    steps_status: (sitting as { steps: Record<string, unknown> | null | undefined }).steps ?? {},
    changelog_entry: changelogEntry(releaseVersionOverride ?? (existing as { release_version?: unknown } | null | undefined)?.release_version ?? null),
    classifications,
    assessment: assessmentViews(steps, classifications, verified, nativeMatrixPath),
    accepted,
    stale_acceptances: staleAcceptances,
    record,
    steps,
    generated: true,
  };
}

// Only a tracked release record is compact; its sitting report remains raw for acceptance recovery.
export function compactReleaseRecord<Report>(report: Report) {
  if ((report as { raw_evidence_retention: unknown }).raw_evidence_retention) return report;
  return {
    ...(report as object),
    retained_quality: compactRetainedQuality((report as { retained_quality: unknown }).retained_quality),
    steps: Object.fromEntries(Object.entries((report as { steps: Record<string, unknown> | null | undefined }).steps ?? {}).map(([id, step]) => [id, compactStep(id, step)])),
    raw_evidence_retention: {
      sitting: (report as { sitting: unknown }).sitting,
      retention: 'Raw artifacts remain in the sitting named above. This compact release record preserves comparison inputs and rendered assessment, but cannot revalidate omitted raw evidence.',
    },
  };
}

// Writes the sitting's own release-gate.{json,md}; once --release has named it, the record under
// reportsDir too, and on PASS repoints the numbers of record. The one landing point for every writer.
export function persist(report: unknown, options: PersistOptions) {
  const { sittingDir, outputDir = sittingDir, reportsDir = REPORTS_DIR, benchmarkingMdPath = BENCHMARKING_MD, analysisOnly = false } = options;
  const storeSummaryPath = options.storeSummaryPath ?? (reportsDir === REPORTS_DIR && benchmarkingMdPath === BENCHMARKING_MD ? STORE_BENCHMARK_SUMMARY_MD : null);
  mkdirSync(outputDir, { recursive: true });
  const targets: [string, string, boolean][] = [[outputDir, SITTING_REPORT, false]];
  if ((report as { release_version: unknown }).release_version && !analysisOnly) {
    mkdirSync(reportsDir, { recursive: true });
    targets.push([reportsDir, reportBase((report as { date: unknown }).date, (report as { release_version: unknown }).release_version), true]);
  }
  const frontmatter = {
    date: (report as { date: unknown }).date,
    title: (report as { title: unknown }).title,
    package_version: (report as { package_version: unknown }).package_version,
    release_version: (report as { release_version: unknown }).release_version,
    chunk_version: (report as { chunk_version: unknown }).chunk_version,
    schema_version: (report as { schema_version: unknown }).schema_version,
    machine: (report as { machine: unknown }).machine,
    node: (report as { node: unknown }).node,
    corpora: (report as { corpora: Record<string, unknown> | null | undefined }).corpora,
    corpus_shape: (report as { corpus_shape: unknown }).corpus_shape,
    embed_model: (report as { embed_model: unknown }).embed_model,
    verdict: (report as { verdict: unknown }).verdict,
    ...(report as { record: Record<string, unknown> }).record,
  };
  const paths = targets.map(([dir, base, compact]) => ({ jsonPath: join(dir, `${base}.json`), mdPath: join(dir, `${base}.md`), compact }));
  for (const { jsonPath, mdPath, compact } of paths) {
    const saved = compact ? compactReleaseRecord(report) : report;
    const md = `---\n${stringify(frontmatter)}---\n\n${renderMarkdown(saved)}`;
    writeFileSync(jsonPath, `${JSON.stringify(saved, compact ? undefined : null, compact ? undefined : 2)}\n`);
    writeFileSync(mdPath, md);
  }
  if ((report as { release_version: unknown }).release_version && (report as { verdict: unknown }).verdict === 'PASS' && !analysisOnly) {
    updateNumbersOfRecord(report, benchmarkingMdPath);
    if (storeSummaryPath) updateStoreBenchmarkSummary(report, storeSummaryPath);
  }
  return paths[paths.length - 1]; // the record when released, else the sitting's own
}

// Every `| metric | value | report |` row currently between the markers, keyed by its metric
// cell, so a regeneration can keep a metric this sitting never measured rather than deleting it.
export function parseNumbersTable(md: string, start: number, end: number) {
  const rows = new Map<string, [string, string]>();
  for (const line of md.slice(start, end).split('\n')) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (!m || m[1] === 'metric' || /^-+$/.test(m[1])) continue;
    rows.set(m[1], [m[2], m[3]]);
  }
  return rows;
}

// The release version a numbers-of-record row's link names, so a historic rerun (--release
// <old version>) can tell whether it is older than the row it would overwrite.
const REPORT_LINK_VERSION_RE = /(\d+\.\d+\.\d+)-release-gate\.md\)/;
const versionOfRow = (row: readonly string[] | undefined) => REPORT_LINK_VERSION_RE.exec(row?.[1] ?? '')?.[1] ?? null;

// Regenerates the numbers-of-record table: a measured metric is added or repointed, an unmeasured
// one keeps its row, nothing is deleted. Never called for a BLOCK, whose numbers are not official.
// A row already pointing at a newer release than this report's is left alone, per row (rows
// already point at different reports), so a historic rerun never moves the numbers backwards.
export function updateNumbersOfRecord(report: unknown, benchmarkingMdPath = BENCHMARKING_MD) {
  if (!existsSync(benchmarkingMdPath)) return;
  const md = readFileSync(benchmarkingMdPath, 'utf8');
  const start = md.indexOf(NUMBERS_START);
  const end = md.indexOf(NUMBERS_END);
  if (start < 0 || end < 0) return; // markers not present yet in this tree; nothing to update
  const rows = parseNumbersTable(md, start + NUMBERS_START.length, end);
  const link = `[${(report as { date: unknown }).date} release gate](benchmark/reports/${reportBase((report as { date: unknown }).date, (report as { release_version: unknown }).release_version)}.md)`;
  for (const [key, value] of Object.entries((report as { record: Record<string, unknown> }).record)) {
    if (value === null || value === undefined) continue;
    const existingVersion = versionOfRow(rows.get(key));
    if (existingVersion && compareVersions((report as { release_version: string }).release_version, existingVersion) < 0) continue;
    rows.set(key, [String(value), link]);
  }
  const table = mdTable(
    ['metric', 'value', 'report'],
    [...rows.entries()].map(([metric, [value, reportLink]]) => [metric, value, reportLink])
  );
  writeFileSync(benchmarkingMdPath, `${md.slice(0, start)}${NUMBERS_START}\n\n${table}\n\n${md.slice(end)}`);
}

const STORE_SUMMARY_METRICS = [
  ['cold_crawl_ms', 'Cold index'],
  ['warm_query_ms', 'Warm count'],
  ['find_ms', 'Lexical search'],
  ['semantic_find_ms', 'Semantic search'],
];

function storeRecordPrefix(store: string) {
  return store === DEFAULT_STORE ? 'hub' : `battery_${store}_hub`;
}

function metricCell(value: unknown) {
  return Number.isFinite(value) ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value as number)} ms` : 'not measured';
}

function semanticNdcg(report: unknown, store: string) {
  const row = (report as { assessment: ReturnType<typeof assessmentViews> | null | undefined }).assessment?.current_common_query_relevance?.find(([rowStore, corpus, variant, metric]) => rowStore === store && corpus === 'portable-eval-nfcorpus' && variant === 'semantic' && metric === 'ndcg');
  return (row as Record<string, unknown> | null | undefined)?.[4] ?? 'not measured';
}

export function renderStoreBenchmarkSummary(report: unknown) {
  const notes = (((report as { corpus_shape: unknown }).corpus_shape as { hub?: unknown } | null | undefined)?.hub as { notes?: unknown } | null | undefined)?.notes;
  const rows = OFFERED.map((store) => {
    const prefix = storeRecordPrefix(store);
    return [store, ...STORE_SUMMARY_METRICS.map(([key]) => metricCell((report as { record: Record<string, unknown> }).record?.[`${prefix}_${key}`])), semanticNdcg(report, store)];
  });
  const timingScope = Number.isFinite(notes) ? `the same ${new Intl.NumberFormat('en-US').format(notes as number)}-note tree` : 'the same tree';
  return `<!-- sense-store-benchmark release=${(report as { release_version: unknown }).release_version} -->
# Current store benchmark summary

The release assessment generated this file for store selection. Release \`${(report as { release_version: unknown }).release_version}\` passed on ${(report as { date: unknown }).date}, measured on ${(report as { machine: unknown }).machine ?? 'an unrecorded machine'} with Node ${(report as { node: unknown }).node ?? 'unrecorded'}.

The timing rows ran on ${timingScope}. They include CLI startup and each store's complete selected path. Ranked candidates and downstream work can differ by store, so these are current operating measurements rather than an isolated database-engine contest.

${mdTable(['Store', ...STORE_SUMMARY_METRICS.map(([, label]) => label), 'Portable semantic nDCG@10'], rows)}

Cold index measures core index creation and a count query, excluding document embeddings. Warm count is a no-change \`COUNT(*)\` query. Lexical and semantic search are steady-state \`sense search\` commands. Lower timing is faster. Higher nDCG@10 is better; that quality column uses the same NFCorpus queries, judgments, result count, and model on every store.

Choose from the intended workflow, capabilities, and SQL compatibility. These numbers describe the current Sense implementations, not a permanent ranking of the engines. Treat small timing or relevance differences as diagnostic unless a representative workload for the target tree reproduces them.
`;
}

export function updateStoreBenchmarkSummary(report: unknown, storeSummaryPath = STORE_BENCHMARK_SUMMARY_MD) {
  if (existsSync(storeSummaryPath)) {
    const existingVersion = STORE_SUMMARY_VERSION_RE.exec(readFileSync(storeSummaryPath, 'utf8'))?.[1];
    if (existingVersion && compareVersions((report as { release_version: string }).release_version, existingVersion) < 0) return false;
  }
  mkdirSync(dirname(storeSummaryPath), { recursive: true });
  writeFileSync(storeSummaryPath, renderStoreBenchmarkSummary(report));
  return true;
}

// id is a classification row id, or a stage reason exactly as the report's stage_reasons carries
// it (`<step id>: <status>`). Both record the same way, so the published record shows the decision.
export function acceptRow(id: string, reason: unknown, { sittingDir = newestSittingDir(), reportsDir = REPORTS_DIR, benchmarkingMdPath = BENCHMARKING_MD } = {}) {
  // This is the only path that turns a BLOCK into a PASS, so a blank reason is refused here
  // rather than only at the CLI: an override with nothing written in it records no decision.
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`accepting "${id}" needs a reason in the owner's own words; an override with no reason records no decision`);
  }
  if (id.endsWith(': cancelled')) throw new Error(`"${id}" was cancelled by the operator, not measured; re-run it rather than accepting it`);
  const jsonPath = join(sittingDir, `${SITTING_REPORT}.json`);
  if (!existsSync(jsonPath)) throw new Error(`no report under ${sittingDir} to accept against; run node benchmark/gate.ts first`);
  const report: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const stageReasons = (report as { stage_reasons: string[] | null | undefined }).stage_reasons ?? [];
  const unmeasured = (report as { unmeasured_reasons: string[] | null | undefined }).unmeasured_reasons ?? [];
  if (!(report as { classifications: Classification[] }).classifications.some((c) => c.id === id) && !stageReasons.includes(id)) {
    throw new Error(`"${id}" is neither a row nor a stage reason in ${jsonPath}. Known stage reasons:\n${stageReasons.map((r) => `  ${r}`).join('\n') || '  (none)'}\nKnown row ids:\n${(report as { classifications: Classification[] }).classifications.map((c) => `  ${c.id}`).join('\n')}`);
  }
  (report as { accepted: AcceptanceEntries }).accepted[id] = { reason, date: new Date().toISOString().slice(0, 10), evidence_fingerprint: acceptanceFingerprint(id, report, sittingDir) };
  delete (report as { stale_acceptances: AcceptanceEntries }).stale_acceptances?.[id];
  // unmeasured never runs through blockingStageReasons: it is not filtered by accepted, and id
  // can never equal one of its entries (the check above already refused any id not in stageReasons).
  const { verdict, reasons } = aggregateVerdict((report as { classifications: Classification[] }).classifications, [...blockingStageReasons(stageReasons, (report as { accepted: AcceptanceEntries }).accepted), ...unmeasured], (report as { accepted: AcceptanceEntries }).accepted);
  (report as { verdict: unknown }).verdict = verdict;
  (report as { verdict_reasons: unknown[] }).verdict_reasons = reasons;
  persist(report, { sittingDir, reportsDir, benchmarkingMdPath });
  return report;
}

async function main() {
  const {
    values: { accept: acceptId, reason, sitting: sittingArg, out: outputArg, release: releaseVersionOverride, 'native-matrix': nativeMatrixArg },
  } = parseArgs({
    options: { accept: { type: 'string' }, reason: { type: 'string' }, sitting: { type: 'string' }, out: { type: 'string' }, release: { type: 'string' }, 'native-matrix': { type: 'string' } },
  });
  const requestedSitting = sittingArg ? resolve(sittingArg) : undefined;
  if (acceptId !== undefined) {
    if (outputArg) throw new Error('--out cannot be used with --accept');
    if (!acceptId || !reason) {
      console.error('usage: node benchmark/report.ts --accept <row id | stage reason> --reason "<owner words>"');
      process.exit(2);
    }
    const report = acceptRow(acceptId, reason, requestedSitting ? { sittingDir: requestedSitting } : {});
    console.log(`accepted ${acceptId}: ${reason}`);
    console.log(`verdict now: ${(report as { verdict: unknown }).verdict}`);
    return;
  }

  const sittingDir = requestedSitting ?? newestSittingDir();
  if (outputArg && releaseVersionOverride) throw new Error('--out cannot be used with --release');
  if (!existsSync(join(sittingDir, 'sitting.json'))) {
    console.error(`no sitting.json under ${sittingDir}`);
    process.exit(2);
  }
  const report = buildReport(sittingDir, { releaseVersionOverride, nativeMatrixPath: nativeMatrixArg ? resolve(nativeMatrixArg) : null });
  const outputDir = outputArg ? resolve(outputArg) : sittingDir;
  const { mdPath } = persist(report, { sittingDir, outputDir, analysisOnly: Boolean(outputArg) });
  console.log(`wrote ${relative(ROOT, mdPath)}`);
  console.log(`verdict: ${(report as { verdict: unknown }).verdict}`);
  const repointed = (report as { release_version: unknown }).release_version && (report as { verdict: unknown }).verdict === 'PASS';
  console.log(repointed ? 'numbers of record and shipped store summary: updated' : `numbers of record and shipped store summary: left as they were (${(report as { release_version: unknown }).release_version ? 'BLOCK' : 'not released'})`);
}

// Only run the CLI when this file is the entry point; report.ts's functions are also imported
// directly by test/integration/docs.test.ts, which must not trigger a real render as a side effect.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as { message: unknown }).message ?? err);
    process.exit(1);
  });
}
