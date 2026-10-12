import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDownloadable, MODEL_FILES, modelDir, readRef } from '../../dist/esm/embed/identity.js';
import { cachedCorpusPaths } from './corpus.ts';
import { readLabels } from './labels.ts';
import { MEASURE_VERSION } from './measure.ts';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES, revalidateQualityArtifact } from './portable-quality.ts';
import { queryFormFor } from './quality.ts';
import { qualityRetrievalIdentity } from './quality-retrieval-identity.ts';
import { compactStep } from './report-compaction.ts';
import { findPriorReports } from './verdict.ts';
import { captureFileManifest } from './work-tree.ts';
import { directoryIdentity, identityHash, manifestIdentity, pathSetIdentity } from './workload-identity.ts';

type Fields = Record<string, unknown>;
type RetrievalIdentity = ReturnType<typeof qualityRetrievalIdentity>;
interface InspectOptions {
  reportsDir: string;
  sittingsDir: string;
  baselineVersion: unknown;
  currentRoot: string;
  expectedSource?: unknown;
}
interface SourceCandidate {
  name: unknown;
  report: unknown;
  sittingName: unknown;
  kind: unknown;
}
interface RetainedInspection {
  schema: string;
  valid: boolean;
  status: string;
  errors: string[];
  measure_version?: typeof MEASURE_VERSION;
  scope?: typeof RETAINED_QUALITY_SCOPE;
  source?: { kind: unknown; report: unknown; release_version: unknown; sitting: unknown; package_version: unknown };
  raw_evidence?: Record<string, string>;
  source_compact?: Fields;
  source_steps_status?: Fields;
  current_inputs?: Fields;
  artifacts?: Fields;
}

export const RETAINED_QUALITY_SCHEMA = 'retained-quality-v2';
export const RETAINED_QUALITY_GATE = 'quality-revalidation';

export const RETAINED_QUALITY_SCOPE = {
  corpus: 'nfcorpus',
  split: 'test',
  k: 10,
  query_form: 'bare-and',
  stores: [...PORTABLE_QUALITY_STORES],
};

export const retainedQualityIds = [...PORTABLE_QUALITY_STORES.map((store) => `portable-eval-nfcorpus-${store}`), 'portable-eval-nfcorpus-comparison'];
export const retainedQualityProducerIds = retainedQualityIds.filter((id) => !id.endsWith('-comparison'));

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const tryReadJson = (path: string): unknown => {
  try {
    return readJson(path);
  } catch {
    return null;
  }
};
const isObject = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileIdentity = (path: string) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`quality model path is not a regular file: ${path}`);
  return { bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

function currentModelObservation(model: Fields) {
  if ((model as { provider?: unknown }).provider !== 'static') return { provider: (model as { provider?: unknown }).provider, model: (model as { model?: unknown }).model, revision: 'unknown', reuse_eligible: false };
  const ref = isDownloadable((model as { model?: unknown }).model as string) ? (readRef((model as { model?: unknown }).model as string) ?? null) : null;
  try {
    const files = Object.fromEntries(MODEL_FILES.map((name) => [name, fileIdentity(join(modelDir((model as { model?: unknown }).model as string), name))]));
    return { provider: 'static', model: (model as { model?: unknown }).model, ref, files, fingerprint: identityHash(files), reuse_eligible: true };
  } catch (error) {
    return { provider: 'static', model: (model as { model?: unknown }).model, ref, status: 'unknown', error: (error as { message?: unknown } | null | undefined)?.message ?? String(error), reuse_eligible: false };
  }
}
function validateCacheProvenance(artifact: unknown, id: string, report: unknown) {
  const errors: string[] = [];
  const cache = (artifact as { cache?: unknown } | null | undefined)?.cache;
  if (!isObject(cache) || !isObject((cache as { cache_inputs?: unknown }).cache_inputs) || typeof (cache as { cache_fingerprint?: unknown }).cache_fingerprint !== 'string' || identityHash((cache as { cache_inputs?: unknown }).cache_inputs) !== (cache as { cache_fingerprint?: unknown }).cache_fingerprint)
    return [`${id}: prepared-index provenance is missing or invalid`];
  const { implementation, model, source } = (cache as { cache_inputs?: unknown }).cache_inputs as Fields;
  if (!isObject(implementation) || !isObject(source) || !isObject(model)) errors.push(`${id}: prepared-index input provenance is incomplete`);
  if (((implementation as { measured_package?: unknown } | null | undefined)?.measured_package as { version?: unknown } | null | undefined)?.version !== (report as { package_version?: unknown }).package_version)
    errors.push(`${id}: measured package provenance does not match release ${(report as { package_version?: unknown }).package_version}`);
  if ((model as { reuse_eligible?: unknown } | null | undefined)?.reuse_eligible !== true || typeof (model as { fingerprint?: unknown }).fingerprint !== 'string') errors.push(`${id}: model provenance is not reuse-eligible`);
  if (((cache as { model_after_run?: unknown }).model_after_run as { fingerprint?: unknown } | null | undefined)?.fingerprint !== (model as { fingerprint?: unknown } | null | undefined)?.fingerprint) errors.push(`${id}: model identity changed during collection`);
  if ((artifact as { no_silent_change?: unknown }).no_silent_change !== true) errors.push(`${id}: no-silent-change evidence is missing`);
  return errors;
}

function validateCurrentInputs(artifact: unknown, id: string, currentRoot: string, currentRetrieval: RetrievalIdentity) {
  const errors: string[] = [];
  let currentModel: ReturnType<typeof currentModelObservation> | null = null;
  if ((artifact as { corpus?: unknown }).corpus !== RETAINED_QUALITY_SCOPE.corpus || (artifact as { split?: unknown }).split !== RETAINED_QUALITY_SCOPE.split || (artifact as { k?: unknown }).k !== RETAINED_QUALITY_SCOPE.k)
    errors.push(`${id}: retained artifact is not the full ${RETAINED_QUALITY_SCOPE.corpus} gate workload (${RETAINED_QUALITY_SCOPE.split} split, k=${RETAINED_QUALITY_SCOPE.k})`);
  const cacheInputs = ((artifact as { cache?: unknown }).cache as { cache_inputs?: unknown } | null | undefined)?.cache_inputs;
  const recordedRetrieval = (cacheInputs as { retrieval?: unknown } | null | undefined)?.retrieval;
  if (isObject(recordedRetrieval) && typeof (recordedRetrieval as { fingerprint?: unknown }).fingerprint === 'string') {
    if ((recordedRetrieval as { fingerprint?: unknown }).fingerprint !== identityHash((recordedRetrieval as { inputs?: unknown }).inputs)) errors.push(`${id}: recorded retrieval identity is invalid`);
    else if ((recordedRetrieval as { fingerprint?: unknown }).fingerprint !== currentRetrieval.fingerprint) errors.push(`${id}: current retrieval identity differs from collection`);
  } else {
    const measured = ((cacheInputs as { implementation?: unknown } | null | undefined)?.implementation as { measured_package?: unknown } | null | undefined)?.measured_package;
    const current = {
      package_json: pathSetIdentity(currentRoot, ['package.json']),
      source: directoryIdentity(join(currentRoot, 'src')),
      dist: directoryIdentity(join(currentRoot, 'dist')),
    };
    if (!isObject(measured) || identityHash({ package_json: (measured as { package_json?: unknown }).package_json, source: (measured as { source?: unknown }).source, dist: (measured as { dist?: unknown }).dist }) !== identityHash(current)) errors.push(`${id}: legacy whole-package identity differs from current code`);
    if ((((cacheInputs as { implementation?: unknown } | null | undefined)?.implementation as { runtime?: unknown } | null | undefined)?.runtime as { node?: unknown } | null | undefined)?.node !== process.version) errors.push(`${id}: current runtime differs from collection`);
  }
  const model = (cacheInputs as { model?: unknown } | null | undefined)?.model;
  if (isObject(model)) {
    currentModel = currentModelObservation(model);
    if (
      (model as { reuse_eligible?: unknown }).reuse_eligible !== true ||
      (currentModel as { reuse_eligible?: unknown }).reuse_eligible !== true ||
      (model as { fingerprint?: unknown }).fingerprint !== (currentModel as { fingerprint?: unknown }).fingerprint ||
      (model as { ref?: unknown }).ref !== (currentModel as { ref?: unknown }).ref
    )
      errors.push(`${id}: current model identity differs from collection`);
  }
  const corpusIdentity = (((((artifact as { variants?: unknown }).variants as { [key: string]: unknown } | null | undefined)?.['bm25-only'] as { workload_identity?: unknown } | null | undefined)?.workload_identity as { inputs?: unknown } | null | undefined)?.inputs as { corpus?: unknown } | null | undefined)?.corpus;
  const { tree: currentCorpusPath, labels: labelsPath } = cachedCorpusPaths((artifact as { corpus?: unknown }).corpus as string, join(currentRoot, '.tmp', 'cache'));
  if (!isObject(corpusIdentity) || !currentCorpusPath || !existsSync(currentCorpusPath)) errors.push(`${id}: current corpus source is unavailable`);
  else {
    const currentCorpus = manifestIdentity(captureFileManifest(currentCorpusPath));
    if (identityHash(corpusIdentity) !== identityHash(currentCorpus)) errors.push(`${id}: current corpus identity differs from collection`);
  }
  const queryFor = queryFormFor((artifact as { query_form?: unknown }).query_form as string);
  let labelsIdentity = null;
  if (!labelsPath || !queryFor) errors.push(`${id}: current labels or query form are unavailable`);
  else {
    const { queries, qrels } = readLabels(labelsPath, (artifact as { split?: unknown }).split as string);
    const qids = [...qrels.keys()].sort();
    if ((artifact as { queries?: unknown }).queries !== qids.length) errors.push(`${id}: current full query count differs from collection`);
    const expected = {
      query_evidence: Object.fromEntries(qids.map((qid) => [qid, { text: queries.get(qid), canonical: queryFor(queries.get(qid) as string) }])),
      qrels: Object.fromEntries(qids.map((qid) => [qid, Object.fromEntries(qrels.get(qid) as Map<string, number>)])),
    };
    labelsIdentity = identityHash(expected);
    if (labelsIdentity !== identityHash({ query_evidence: (artifact as { query_evidence?: unknown }).query_evidence, qrels: (artifact as { qrels?: unknown }).qrels })) errors.push(`${id}: current queries, qrels, or canonical form differ from collection`);
  }
  return { errors, current: { retrieval: currentRetrieval, model: currentModel ?? null, corpus: corpusIdentity ?? null, labels: labelsIdentity } };
}

function summarizedArtifact(artifact: unknown, compactSource: unknown) {
  const summary: unknown = JSON.parse(JSON.stringify(artifact));
  delete (summary as { query_evidence?: unknown }).query_evidence;
  delete (summary as { qrels?: unknown }).qrels;
  delete (summary as { paired?: unknown }).paired;
  for (const variant of Object.values((summary as { variants?: unknown }).variants ?? ({} as Record<string, unknown>))) if (isObject(variant)) delete (variant as { per_query?: unknown }).per_query;
  if (isObject((summary as { cache?: unknown }).cache)) {
    (summary as { cache?: unknown }).cache = {
      cache_fingerprint: ((summary as { cache?: unknown }).cache as { cache_fingerprint?: unknown }).cache_fingerprint,
      source: (((summary as { cache?: unknown }).cache as { cache_inputs?: unknown }).cache_inputs as { source?: unknown } | null | undefined)?.source ?? null,
      implementation: (((summary as { cache?: unknown }).cache as { cache_inputs?: unknown }).cache_inputs as { implementation?: unknown } | null | undefined)?.implementation ?? null,
      model: (((summary as { cache?: unknown }).cache as { cache_inputs?: unknown }).cache_inputs as { model?: unknown } | null | undefined)?.model ?? null,
    };
  }
  return { ...(summary as object), retained_metrics_recomputed: true, retained_raw_evidence: (compactSource as { omitted_evidence?: unknown }).omitted_evidence ?? null };
}

function sourceCandidates(reportsDir: string, sittingsDir: string, baselineVersion: unknown): SourceCandidate[] {
  let priorReports: ReturnType<typeof findPriorReports> = [];
  try {
    priorReports = findPriorReports(reportsDir, baselineVersion as string | null | undefined);
  } catch {
    // Corrupt retained history is unusable evidence. Selection will schedule fresh collection.
  }
  const promoted = priorReports
    .filter(({ report }) => (report as { measure_version?: unknown }).measure_version === MEASURE_VERSION)
    .map(({ name, report }) => {
      const retained = ((report as { retained_quality?: unknown }).retained_quality as { valid?: unknown } | null | undefined)?.valid ? ((report as { retained_quality?: unknown }).retained_quality as { source?: unknown }).source : null;
      if (retained) {
        const sourceCompact = ((report as { retained_quality?: unknown }).retained_quality as { source_compact?: unknown }).source_compact;
        const sourceCompactHashes = ((report as { retained_quality?: unknown }).retained_quality as { source_compact_hashes?: unknown }).source_compact_hashes;
        const rawEvidence = ((report as { retained_quality?: unknown }).retained_quality as { raw_evidence?: unknown }).raw_evidence;
        const sourceStatuses = ((report as { retained_quality?: unknown }).retained_quality as { source_steps_status?: unknown }).source_steps_status;
        return (sourceCompact || (sourceCompactHashes && rawEvidence)) && sourceStatuses
          ? {
              name: (retained as { report?: unknown }).report,
              report: { package_version: (retained as { package_version?: unknown }).package_version, release_version: (retained as { release_version?: unknown }).release_version, steps: sourceCompact, steps_status: sourceStatuses, source_compact_hashes: sourceCompactHashes, raw_evidence: rawEvidence },
              sittingName: (retained as { sitting?: unknown }).sitting,
              kind: (retained as { kind?: unknown }).kind ?? 'promoted',
            }
          : null;
      }
      return ((report as { raw_evidence_retention?: unknown }).raw_evidence_retention as { sitting?: unknown } | null | undefined)?.sitting &&
        retainedQualityProducerIds.every((id) => (((report as { steps_status?: unknown }).steps_status as { [key: string]: unknown } | null | undefined)?.[id] as { status?: unknown } | null | undefined)?.status === 'ok')
        ? { name, report, sittingName: ((report as { raw_evidence_retention?: unknown }).raw_evidence_retention as { sitting?: unknown }).sitting, kind: 'promoted' }
        : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => (candidate && retainedQualityProducerIds.every((id) => ((candidate.report as { steps_status?: unknown }).steps_status as Record<string, { status?: unknown } | null | undefined> | null | undefined)?.[id]?.status === 'ok')) as boolean);
  const local = existsSync(sittingsDir)
    ? readdirSync(sittingsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && retainedQualityProducerIds.every((id) => existsSync(join(sittingsDir, entry.name, `${id}.json`))) && existsSync(join(sittingsDir, entry.name, 'release-gate.json')))
        .map((entry) => ({ name: 'release-gate.json', report: tryReadJson(join(sittingsDir, entry.name, 'release-gate.json')), sittingName: entry.name, kind: 'sitting' }))
        .filter(
          ({ report }) =>
            (report as { measure_version?: unknown } | null | undefined)?.measure_version === MEASURE_VERSION &&
            retainedQualityProducerIds.every((id) => (((report as { steps_status?: unknown }).steps_status as { [key: string]: unknown } | null | undefined)?.[id] as { status?: unknown } | null | undefined)?.status === 'ok')
        )
        .sort((a, b) => b.sittingName.localeCompare(a.sittingName))
    : [];
  return [...local, ...promoted];
}

function sourceCandidate(reportsDir: string, sittingsDir: string, baselineVersion: unknown, expectedSource: unknown) {
  const candidates = sourceCandidates(reportsDir, sittingsDir, baselineVersion);
  if (expectedSource) return candidates.find(({ name, sittingName, kind }) => name === (expectedSource as { report?: unknown }).report && sittingName === (expectedSource as { sitting?: unknown }).sitting && kind === ((expectedSource as { kind?: unknown }).kind ?? 'promoted')) ?? null;
  return candidates[0] ?? null;
}

/** @param {{ reportsDir: string, sittingsDir: string, baselineVersion: unknown, currentRoot: string, expectedSource?: { report: string, sitting: string, kind?: string } | null }} options */
export async function inspectRetainedQuality({ reportsDir, sittingsDir, baselineVersion, currentRoot, expectedSource = null }: InspectOptions): Promise<RetainedInspection> {
  const errors: string[] = [];
  const candidate = sourceCandidate(reportsDir, sittingsDir, baselineVersion, expectedSource);
  if (!candidate) return { schema: RETAINED_QUALITY_SCHEMA, valid: false, status: 'missing', errors: ['no compatible compact report names retained raw quality evidence'] };
  const { name, report, sittingName, kind } = candidate;
  if (basename(sittingName as string) !== sittingName) return { schema: RETAINED_QUALITY_SCHEMA, valid: false, status: 'invalid', errors: [`${name}: retained sitting name is invalid`] };
  const sourceDir = join(sittingsDir, sittingName as string);
  const rawById: Fields = {};
  const rawEvidence: Record<string, string> = {};
  const sourceCompact: Fields = {};
  for (const id of retainedQualityProducerIds) {
    const path = join(sourceDir, `${id}.json`);
    if (!existsSync(path)) {
      errors.push(`${id}: retained raw artifact is missing`);
      continue;
    }
    try {
      const raw = readJson(path);
      const rawCompact = compactStep(id, raw);
      const compact = (report as { source_compact_hashes?: unknown }).source_compact_hashes
        ? rawCompact
        : kind === 'sitting'
          ? compactStep(id, ((report as { steps?: unknown }).steps as { [key: string]: unknown } | null | undefined)?.[id])
          : ((report as { steps?: unknown }).steps as { [key: string]: unknown } | null | undefined)?.[id];
      if ((report as { raw_evidence?: unknown }).raw_evidence && identityHash(raw) !== ((report as { raw_evidence?: unknown }).raw_evidence as { [key: string]: unknown })[id]) errors.push(`${id}: retained raw artifact does not match its recorded identity`);
      if ((report as { source_compact_hashes?: unknown }).source_compact_hashes && identityHash(rawCompact) !== ((report as { source_compact_hashes?: unknown }).source_compact_hashes as { [key: string]: unknown })[id]) errors.push(`${id}: retained raw artifact does not match the compact report identity`);
      if (!compact || (!(report as { source_compact_hashes?: unknown }).source_compact_hashes && identityHash(rawCompact) !== identityHash(compact))) errors.push(`${id}: retained raw artifact does not match the compact report`);
      rawById[id] = raw;
      rawEvidence[id] = identityHash(raw);
      (sourceCompact as { [key: string]: unknown })[id] = compact;
    } catch (error) {
      errors.push(`${id}: ${(error as { message?: unknown } | null | undefined)?.message ?? String(error)}`);
    }
  }
  const artifacts: Fields = {};
  const currentInputs: Fields = {};
  let currentRetrieval: RetrievalIdentity | undefined;
  try {
    currentRetrieval = qualityRetrievalIdentity(currentRoot);
  } catch (error) {
    errors.push(`current retrieval identity: ${(error as { message?: unknown } | null | undefined)?.message ?? String(error)}`);
  }
  const portable: unknown[] = [];
  for (const store of PORTABLE_QUALITY_STORES) {
    const id = `portable-eval-nfcorpus-${store}`;
    const raw = rawById[id];
    if (!raw || !currentRetrieval) continue;
    try {
      errors.push(...validateCacheProvenance(raw, id, report));
      const current = validateCurrentInputs(raw, id, currentRoot, currentRetrieval);
      errors.push(...current.errors);
      currentInputs[id] = current.current;
      const checked = revalidateQualityArtifact(raw, { store, queryForm: RETAINED_QUALITY_SCOPE.query_form });
      errors.push(...((checked as { errors?: string[] }).errors as string[]).map((error) => `${id}: ${error}`));
      if (((checked as { errors?: string[] }).errors as string[]).length === 0) {
        portable.push((checked as { artifact?: unknown }).artifact);
        artifacts[id] = summarizedArtifact((checked as { artifact?: unknown }).artifact, (sourceCompact as { [key: string]: unknown })[id]);
      }
    } catch (error) {
      errors.push(`${id}: ${(error as { message?: unknown } | null | undefined)?.message ?? String(error)}`);
    }
  }
  if (portable.length === PORTABLE_QUALITY_STORES.length) {
    const comparison = comparePortableQualityArtifacts(portable);
    if (!comparison.valid) errors.push(`portable-eval-nfcorpus-comparison: ${comparison.errors.join('; ')}`);
    else artifacts['portable-eval-nfcorpus-comparison'] = comparison;
  }
  const valid = errors.length === 0 && Object.keys(artifacts as Record<string, unknown>).length === retainedQualityIds.length;
  return {
    schema: RETAINED_QUALITY_SCHEMA,
    measure_version: MEASURE_VERSION,
    scope: RETAINED_QUALITY_SCOPE,
    valid,
    status: valid ? 'revalidated' : 'invalid',
    errors,
    source: { kind, report: name, release_version: (report as { release_version?: unknown }).release_version ?? null, sitting: sittingName, package_version: (report as { package_version?: unknown }).package_version ?? null },
    raw_evidence: rawEvidence,
    source_compact: sourceCompact,
    source_steps_status: Object.fromEntries(retainedQualityProducerIds.map((id) => [id, ((report as { steps_status?: unknown }).steps_status as { [key: string]: unknown } | null | undefined)?.[id] ?? null])),
    current_inputs: currentInputs,
    artifacts: valid ? artifacts : {},
  };
}

export function validateRetainedQualityRecord(record: unknown, { sittingsDir, currentRoot, expectedSource = null }: { sittingsDir: string; currentRoot: string; expectedSource?: unknown }) {
  const errors: string[] = [];
  if (!isObject(record) || (record as { schema?: unknown }).schema !== RETAINED_QUALITY_SCHEMA || (record as { valid?: unknown }).valid !== true || (record as { status?: unknown }).status !== 'revalidated') return ['retained-quality artifact is not a successful revalidation'];
  if (identityHash((record as { scope?: unknown }).scope) !== identityHash(RETAINED_QUALITY_SCOPE)) errors.push('retained-quality scope is not portable NFCorpus on every offered store');
  if (expectedSource && identityHash((record as { source?: unknown }).source) !== identityHash(expectedSource)) errors.push('retained-quality source differs from the selected source');
  const report = { package_version: ((record as { source?: unknown }).source as { package_version?: unknown } | null | undefined)?.package_version };
  if (!isObject((record as { source?: unknown }).source) || basename((((record as { source?: unknown }).source as { sitting?: unknown }).sitting ?? '') as string) !== ((record as { source?: unknown }).source as { sitting?: unknown }).sitting) errors.push('retained-quality source provenance is invalid');
  for (const id of retainedQualityProducerIds) if ((((record as { source_steps_status?: unknown }).source_steps_status as { [key: string]: unknown } | null | undefined)?.[id] as { status?: unknown } | null | undefined)?.status !== 'ok') errors.push(`${id}: source producer did not complete successfully`);
  if (identityHash(Object.keys((record as { source_steps_status?: unknown }).source_steps_status ?? ({} as Record<string, unknown>)).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality source producer coverage is not the required subset');
  if (identityHash(Object.keys((record as { raw_evidence?: unknown }).raw_evidence ?? ({} as Record<string, unknown>)).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality raw evidence coverage is not the required subset');
  if (identityHash(Object.keys((record as { source_compact?: unknown }).source_compact ?? ({} as Record<string, unknown>)).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality compact source coverage is incomplete');
  if (identityHash(Object.keys((record as { artifacts?: unknown }).artifacts ?? ({} as Record<string, unknown>)).sort()) !== identityHash([...retainedQualityIds].sort())) errors.push('retained-quality summarized artifact coverage is incomplete');
  if (identityHash(Object.keys((record as { current_inputs?: unknown }).current_inputs ?? ({} as Record<string, unknown>)).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality current input coverage is incomplete');
  const currentRetrieval = qualityRetrievalIdentity(currentRoot);
  const normalizedPortable: unknown[] = [];
  for (const store of PORTABLE_QUALITY_STORES) {
    const id = `portable-eval-nfcorpus-${store}`;
    const path = join(sittingsDir, ((record as { source?: unknown }).source as { sitting?: unknown }).sitting as string, `${id}.json`);
    if (!existsSync(path)) {
      errors.push(`${id}: retained raw artifact is missing`);
      continue;
    }
    try {
      const raw = readJson(path);
      const compactSource = ((record as { source_compact?: unknown }).source_compact as { [key: string]: unknown } | null | undefined)?.[id];
      if (identityHash(raw) !== ((record as { raw_evidence?: unknown }).raw_evidence as { [key: string]: unknown } | null | undefined)?.[id]) errors.push(`${id}: retained raw artifact changed after revalidation`);
      if (identityHash(compactStep(id, raw)) !== identityHash(compactSource)) errors.push(`${id}: retained raw artifact no longer matches the source report`);
      errors.push(...validateCacheProvenance(raw, id, report));
      const current = validateCurrentInputs(raw, id, currentRoot, currentRetrieval);
      errors.push(...current.errors);
      if (identityHash(current.current) !== identityHash(((record as { current_inputs?: unknown }).current_inputs as { [key: string]: unknown } | null | undefined)?.[id])) errors.push(`${id}: current input evidence differs from the revalidation record`);
      const checked = revalidateQualityArtifact(raw, { store, queryForm: RETAINED_QUALITY_SCOPE.query_form });
      errors.push(...((checked as { errors?: string[] }).errors as string[]).map((error) => `${id}: ${error}`));
      if (((checked as { errors?: string[] }).errors as string[]).length === 0) {
        if (identityHash(summarizedArtifact((checked as { artifact?: unknown }).artifact, compactSource)) !== identityHash(((record as { artifacts?: unknown }).artifacts as { [key: string]: unknown } | null | undefined)?.[id])) errors.push(`${id}: summarized metrics differ from recomputed retained rankings`);
        normalizedPortable.push((checked as { artifact?: unknown }).artifact);
      }
    } catch (error) {
      errors.push(`${id}: ${(error as { message?: unknown } | null | undefined)?.message ?? String(error)}`);
    }
  }
  if (normalizedPortable.length === PORTABLE_QUALITY_STORES.length) {
    const comparisonId = 'portable-eval-nfcorpus-comparison';
    const comparison = comparePortableQualityArtifacts(normalizedPortable);
    if (!comparison.valid || identityHash(comparison) !== identityHash(((record as { artifacts?: unknown }).artifacts as { [key: string]: unknown } | null | undefined)?.[comparisonId])) errors.push(`${comparisonId}: summarized comparison differs from recomputed retained rankings`);
  }
  return errors;
}

export function retainedQualitySummary(record: unknown) {
  return {
    schema: (record as { schema?: unknown }).schema,
    measure_version: (record as { measure_version?: unknown }).measure_version ?? MEASURE_VERSION,
    scope: (record as { scope?: unknown }).scope ?? null,
    valid: (record as { valid?: unknown }).valid,
    status: (record as { status?: unknown }).status,
    errors: (record as { errors?: unknown }).errors,
    source: (record as { source?: unknown }).source ?? null,
  };
}
