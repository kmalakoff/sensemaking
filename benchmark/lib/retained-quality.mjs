import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDownloadable, MODEL_FILES, modelDir, readRef } from '../../dist/esm/embed/identity.js';
import { cachedCorpusPaths } from './corpus.mjs';
import { readLabels } from './labels.mjs';
import { MEASURE_VERSION } from './measure.mjs';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES, revalidateQualityArtifact } from './portable-quality.mjs';
import { queryFormFor } from './quality.mjs';
import { qualityRetrievalIdentity } from './quality-retrieval-identity.mjs';
import { compactStep } from './report-compaction.mjs';
import { findPriorReports } from './verdict.mjs';
import { captureFileManifest } from './work-tree.mjs';
import { directoryIdentity, identityHash, manifestIdentity, pathSetIdentity } from './workload-identity.mjs';

export const RETAINED_QUALITY_SCHEMA = 'retained-quality-v1';
export const RETAINED_QUALITY_GATE = 'quality-revalidation';

const groups = [
  { corpus: 'nfcorpus', gate: 'quality-baseline' },
  { corpus: 'fever', gate: 'fever' },
];

export const retainedQualityIds = groups.flatMap(({ corpus }) => [`eval-${corpus}`, ...PORTABLE_QUALITY_STORES.map((store) => `portable-eval-${corpus}-${store}`), `portable-eval-${corpus}-comparison`]);
export const retainedQualityProducerIds = retainedQualityIds.filter((id) => !id.endsWith('-comparison'));

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const tryReadJson = (path) => {
  try {
    return readJson(path);
  } catch {
    return null;
  }
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileIdentity = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`quality model path is not a regular file: ${path}`);
  return { bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

function currentModelObservation(model) {
  if (model.provider !== 'static') return { provider: model.provider, model: model.model, revision: 'unknown', reuse_eligible: false };
  const ref = isDownloadable(model.model) ? (readRef(model.model) ?? null) : null;
  try {
    const files = Object.fromEntries(MODEL_FILES.map((name) => [name, fileIdentity(join(modelDir(model.model), name))]));
    return { provider: 'static', model: model.model, ref, files, fingerprint: identityHash(files), reuse_eligible: true };
  } catch (error) {
    return { provider: 'static', model: model.model, ref, status: 'unknown', error: error?.message ?? String(error), reuse_eligible: false };
  }
}
function validateCacheProvenance(artifact, id, report) {
  const errors = [];
  const cache = artifact?.cache;
  if (!isObject(cache) || !isObject(cache.cache_inputs) || typeof cache.cache_fingerprint !== 'string' || identityHash(cache.cache_inputs) !== cache.cache_fingerprint) return [`${id}: prepared-index provenance is missing or invalid`];
  const { implementation, model, source } = cache.cache_inputs;
  if (!isObject(implementation) || !isObject(source) || !isObject(model)) errors.push(`${id}: prepared-index input provenance is incomplete`);
  if (implementation?.measured_package?.version !== report.package_version) errors.push(`${id}: measured package provenance does not match release ${report.package_version}`);
  if (model?.reuse_eligible !== true || typeof model.fingerprint !== 'string') errors.push(`${id}: model provenance is not reuse-eligible`);
  if (cache.model_after_run?.fingerprint !== model?.fingerprint) errors.push(`${id}: model identity changed during collection`);
  if (artifact.no_silent_change !== true) errors.push(`${id}: no-silent-change evidence is missing`);
  return errors;
}

function validateCurrentInputs(artifact, id, currentRoot, currentRetrieval) {
  const errors = [];
  let currentModel = null;
  if (artifact.split !== 'test' || artifact.k !== 10) errors.push(`${id}: retained artifact is not the full gate workload (test split, k=10)`);
  const cacheInputs = artifact.cache?.cache_inputs;
  const recordedRetrieval = cacheInputs?.retrieval;
  if (isObject(recordedRetrieval) && typeof recordedRetrieval.fingerprint === 'string') {
    if (recordedRetrieval.fingerprint !== identityHash(recordedRetrieval.inputs)) errors.push(`${id}: recorded retrieval identity is invalid`);
    else if (recordedRetrieval.fingerprint !== currentRetrieval.fingerprint) errors.push(`${id}: current retrieval identity differs from collection`);
  } else {
    const measured = cacheInputs?.implementation?.measured_package;
    const current = {
      package_json: pathSetIdentity(currentRoot, ['package.json']),
      source: directoryIdentity(join(currentRoot, 'src')),
      dist: directoryIdentity(join(currentRoot, 'dist')),
    };
    if (!isObject(measured) || identityHash({ package_json: measured.package_json, source: measured.source, dist: measured.dist }) !== identityHash(current)) errors.push(`${id}: legacy whole-package identity differs from current code`);
    if (cacheInputs?.implementation?.runtime?.node !== process.version) errors.push(`${id}: current runtime differs from collection`);
  }
  const model = cacheInputs?.model;
  if (isObject(model)) {
    currentModel = currentModelObservation(model);
    if (model.reuse_eligible !== true || currentModel.reuse_eligible !== true || model.fingerprint !== currentModel.fingerprint || model.ref !== currentModel.ref) errors.push(`${id}: current model identity differs from collection`);
  }
  const corpusIdentity = artifact.variants?.['bm25-only']?.workload_identity?.inputs?.corpus;
  const { tree: currentCorpusPath, labels: labelsPath } = cachedCorpusPaths(artifact.corpus, join(currentRoot, '.tmp', 'cache'));
  if (!isObject(corpusIdentity) || !currentCorpusPath || !existsSync(currentCorpusPath)) errors.push(`${id}: current corpus source is unavailable`);
  else {
    const currentCorpus = manifestIdentity(captureFileManifest(currentCorpusPath));
    if (identityHash(corpusIdentity) !== identityHash(currentCorpus)) errors.push(`${id}: current corpus identity differs from collection`);
  }
  const queryFor = queryFormFor(artifact.query_form);
  let labelsIdentity = null;
  if (!labelsPath || !queryFor) errors.push(`${id}: current labels or query form are unavailable`);
  else {
    const { queries, qrels } = readLabels(labelsPath, artifact.split);
    const qids = [...qrels.keys()].sort();
    if (artifact.queries !== qids.length) errors.push(`${id}: current full query count differs from collection`);
    const expected = {
      query_evidence: Object.fromEntries(qids.map((qid) => [qid, { text: queries.get(qid), canonical: queryFor(queries.get(qid)) }])),
      qrels: Object.fromEntries(qids.map((qid) => [qid, Object.fromEntries(qrels.get(qid))])),
    };
    labelsIdentity = identityHash(expected);
    if (labelsIdentity !== identityHash({ query_evidence: artifact.query_evidence, qrels: artifact.qrels })) errors.push(`${id}: current queries, qrels, or canonical form differ from collection`);
  }
  return { errors, current: { retrieval: currentRetrieval, model: currentModel ?? null, corpus: corpusIdentity ?? null, labels: labelsIdentity } };
}

function summarizedArtifact(artifact, compactSource) {
  const summary = JSON.parse(JSON.stringify(artifact));
  delete summary.query_evidence;
  delete summary.qrels;
  delete summary.paired;
  for (const variant of Object.values(summary.variants ?? {})) if (isObject(variant)) delete variant.per_query;
  if (isObject(summary.cache)) {
    summary.cache = {
      cache_fingerprint: summary.cache.cache_fingerprint,
      source: summary.cache.cache_inputs?.source ?? null,
      implementation: summary.cache.cache_inputs?.implementation ?? null,
      model: summary.cache.cache_inputs?.model ?? null,
    };
  }
  return { ...summary, retained_metrics_recomputed: true, retained_raw_evidence: compactSource.omitted_evidence ?? null };
}

function sourceCandidates(reportsDir, sittingsDir, baselineVersion) {
  let priorReports = [];
  try {
    priorReports = findPriorReports(reportsDir, baselineVersion);
  } catch {
    // Corrupt retained history is unusable evidence. Selection will schedule fresh collection.
  }
  const promoted = priorReports
    .filter(({ report }) => report.measure_version === MEASURE_VERSION)
    .map(({ name, report }) => {
      const retained = report.retained_quality?.valid ? report.retained_quality.source : null;
      if (retained) {
        const sourceCompact = report.retained_quality.source_compact;
        const sourceCompactHashes = report.retained_quality.source_compact_hashes;
        const rawEvidence = report.retained_quality.raw_evidence;
        const sourceStatuses = report.retained_quality.source_steps_status;
        return (sourceCompact || (sourceCompactHashes && rawEvidence)) && sourceStatuses
          ? {
              name: retained.report,
              report: { package_version: retained.package_version, release_version: retained.release_version, steps: sourceCompact, steps_status: sourceStatuses, source_compact_hashes: sourceCompactHashes, raw_evidence: rawEvidence },
              sittingName: retained.sitting,
              kind: retained.kind ?? 'promoted',
            }
          : null;
      }
      return report.raw_evidence_retention?.sitting && retainedQualityProducerIds.every((id) => report.steps_status?.[id]?.status === 'ok') ? { name, report, sittingName: report.raw_evidence_retention.sitting, kind: 'promoted' } : null;
    })
    .filter((candidate) => candidate && retainedQualityProducerIds.every((id) => candidate.report.steps_status?.[id]?.status === 'ok'));
  const local = existsSync(sittingsDir)
    ? readdirSync(sittingsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && retainedQualityProducerIds.every((id) => existsSync(join(sittingsDir, entry.name, `${id}.json`))) && existsSync(join(sittingsDir, entry.name, 'release-gate.json')))
        .map((entry) => ({ name: 'release-gate.json', report: tryReadJson(join(sittingsDir, entry.name, 'release-gate.json')), sittingName: entry.name, kind: 'sitting' }))
        .filter(({ report }) => report?.measure_version === MEASURE_VERSION && retainedQualityProducerIds.every((id) => report.steps_status?.[id]?.status === 'ok'))
        .sort((a, b) => b.sittingName.localeCompare(a.sittingName))
    : [];
  return [...local, ...promoted];
}

function sourceCandidate(reportsDir, sittingsDir, baselineVersion, expectedSource) {
  const candidates = sourceCandidates(reportsDir, sittingsDir, baselineVersion);
  if (expectedSource) return candidates.find(({ name, sittingName, kind }) => name === expectedSource.report && sittingName === expectedSource.sitting && kind === (expectedSource.kind ?? 'promoted')) ?? null;
  return candidates[0] ?? null;
}

/** @param {{ reportsDir: string, sittingsDir: string, baselineVersion: string, currentRoot: string, expectedSource?: { report: string, sitting: string, kind?: string } | null }} options */
export async function inspectRetainedQuality({ reportsDir, sittingsDir, baselineVersion, currentRoot, expectedSource = null }) {
  const errors = [];
  const candidate = sourceCandidate(reportsDir, sittingsDir, baselineVersion, expectedSource);
  if (!candidate) return { schema: RETAINED_QUALITY_SCHEMA, valid: false, status: 'missing', errors: ['no compatible compact report names retained raw quality evidence'] };
  const { name, report, sittingName, kind } = candidate;
  if (basename(sittingName) !== sittingName) return { schema: RETAINED_QUALITY_SCHEMA, valid: false, status: 'invalid', errors: [`${name}: retained sitting name is invalid`] };
  const sourceDir = join(sittingsDir, sittingName);
  const rawById = {};
  const rawEvidence = {};
  const sourceCompact = {};
  for (const id of retainedQualityProducerIds) {
    const path = join(sourceDir, `${id}.json`);
    if (!existsSync(path)) {
      errors.push(`${id}: retained raw artifact is missing`);
      continue;
    }
    try {
      const raw = readJson(path);
      const rawCompact = compactStep(id, raw);
      const compact = report.source_compact_hashes ? rawCompact : kind === 'sitting' ? compactStep(id, report.steps?.[id]) : report.steps?.[id];
      if (report.raw_evidence && identityHash(raw) !== report.raw_evidence[id]) errors.push(`${id}: retained raw artifact does not match its recorded identity`);
      if (report.source_compact_hashes && identityHash(rawCompact) !== report.source_compact_hashes[id]) errors.push(`${id}: retained raw artifact does not match the compact report identity`);
      if (!compact || (!report.source_compact_hashes && identityHash(rawCompact) !== identityHash(compact))) errors.push(`${id}: retained raw artifact does not match the compact report`);
      rawById[id] = raw;
      rawEvidence[id] = identityHash(raw);
      sourceCompact[id] = compact;
    } catch (error) {
      errors.push(`${id}: ${error?.message ?? String(error)}`);
    }
  }
  const artifacts = {};
  const currentInputs = {};
  let currentRetrieval;
  try {
    currentRetrieval = qualityRetrievalIdentity(currentRoot);
  } catch (error) {
    errors.push(`current retrieval identity: ${error?.message ?? String(error)}`);
  }
  for (const { corpus } of groups) {
    const sqliteId = `eval-${corpus}`;
    const sqliteRaw = rawById[sqliteId];
    if (sqliteRaw && currentRetrieval) {
      try {
        errors.push(...validateCacheProvenance(sqliteRaw, sqliteId, report));
        const current = validateCurrentInputs(sqliteRaw, sqliteId, currentRoot, currentRetrieval);
        errors.push(...current.errors);
        currentInputs[sqliteId] = current.current;
        const checked = revalidateQualityArtifact(sqliteRaw, { store: 'sqlite', queryForm: 'or-bag' });
        errors.push(...checked.errors.map((error) => `${sqliteId}: ${error}`));
        if (checked.errors.length === 0) artifacts[sqliteId] = summarizedArtifact(checked.artifact, sourceCompact[sqliteId]);
      } catch (error) {
        errors.push(`${sqliteId}: ${error?.message ?? String(error)}`);
      }
    }
    const portable = [];
    for (const store of PORTABLE_QUALITY_STORES) {
      const id = `portable-eval-${corpus}-${store}`;
      const raw = rawById[id];
      if (!raw || !currentRetrieval) continue;
      try {
        errors.push(...validateCacheProvenance(raw, id, report));
        const current = validateCurrentInputs(raw, id, currentRoot, currentRetrieval);
        errors.push(...current.errors);
        currentInputs[id] = current.current;
        const checked = revalidateQualityArtifact(raw, { store, queryForm: 'bare-and' });
        errors.push(...checked.errors.map((error) => `${id}: ${error}`));
        if (checked.errors.length === 0) {
          portable.push(checked.artifact);
          artifacts[id] = summarizedArtifact(checked.artifact, sourceCompact[id]);
        }
      } catch (error) {
        errors.push(`${id}: ${error?.message ?? String(error)}`);
      }
    }
    if (portable.length === PORTABLE_QUALITY_STORES.length) {
      const comparison = comparePortableQualityArtifacts(portable);
      if (!comparison.valid) errors.push(`portable-eval-${corpus}-comparison: ${comparison.errors.join('; ')}`);
      else artifacts[`portable-eval-${corpus}-comparison`] = comparison;
    }
  }
  const valid = errors.length === 0 && Object.keys(artifacts).length === retainedQualityIds.length;
  return {
    schema: RETAINED_QUALITY_SCHEMA,
    measure_version: MEASURE_VERSION,
    valid,
    status: valid ? 'revalidated' : 'invalid',
    errors,
    source: { kind, report: name, release_version: report.release_version ?? null, sitting: sittingName, package_version: report.package_version ?? null },
    raw_evidence: rawEvidence,
    source_compact: sourceCompact,
    source_steps_status: Object.fromEntries(retainedQualityProducerIds.map((id) => [id, report.steps_status?.[id] ?? null])),
    current_inputs: currentInputs,
    artifacts: valid ? artifacts : {},
  };
}

export function validateRetainedQualityRecord(record, { sittingsDir, currentRoot, expectedSource = null }) {
  const errors = [];
  if (!isObject(record) || record.schema !== RETAINED_QUALITY_SCHEMA || record.valid !== true || record.status !== 'revalidated') return ['retained-quality artifact is not a successful revalidation'];
  if (expectedSource && identityHash(record.source) !== identityHash(expectedSource)) errors.push('retained-quality source differs from the selected source');
  const report = { package_version: record.source?.package_version };
  if (!isObject(record.source) || basename(record.source.sitting ?? '') !== record.source.sitting) errors.push('retained-quality source provenance is invalid');
  for (const id of retainedQualityProducerIds) if (record.source_steps_status?.[id]?.status !== 'ok') errors.push(`${id}: source producer did not complete successfully`);
  if (identityHash(Object.keys(record.source_compact ?? {}).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality compact source coverage is incomplete');
  if (identityHash(Object.keys(record.artifacts ?? {}).sort()) !== identityHash([...retainedQualityIds].sort())) errors.push('retained-quality summarized artifact coverage is incomplete');
  if (identityHash(Object.keys(record.current_inputs ?? {}).sort()) !== identityHash([...retainedQualityProducerIds].sort())) errors.push('retained-quality current input coverage is incomplete');
  const currentRetrieval = qualityRetrievalIdentity(currentRoot);
  for (const { corpus } of groups) {
    const normalizedPortable = [];
    for (const id of [`eval-${corpus}`, ...PORTABLE_QUALITY_STORES.map((store) => `portable-eval-${corpus}-${store}`)]) {
      const path = join(sittingsDir, record.source.sitting, `${id}.json`);
      if (!existsSync(path)) {
        errors.push(`${id}: retained raw artifact is missing`);
        continue;
      }
      try {
        const raw = readJson(path);
        const compactSource = record.source_compact?.[id];
        if (identityHash(raw) !== record.raw_evidence?.[id]) errors.push(`${id}: retained raw artifact changed after revalidation`);
        if (identityHash(compactStep(id, raw)) !== identityHash(compactSource)) errors.push(`${id}: retained raw artifact no longer matches the source report`);
        errors.push(...validateCacheProvenance(raw, id, report));
        const current = validateCurrentInputs(raw, id, currentRoot, currentRetrieval);
        errors.push(...current.errors);
        if (identityHash(current.current) !== identityHash(record.current_inputs?.[id])) errors.push(`${id}: current input evidence differs from the revalidation record`);
        const store = id === `eval-${corpus}` ? 'sqlite' : id.slice(`portable-eval-${corpus}-`.length);
        const checked = revalidateQualityArtifact(raw, { store, queryForm: id === `eval-${corpus}` ? 'or-bag' : 'bare-and' });
        errors.push(...checked.errors.map((error) => `${id}: ${error}`));
        if (checked.errors.length === 0) {
          if (identityHash(summarizedArtifact(checked.artifact, compactSource)) !== identityHash(record.artifacts?.[id])) errors.push(`${id}: summarized metrics differ from recomputed retained rankings`);
          if (id !== `eval-${corpus}`) normalizedPortable.push(checked.artifact);
        }
      } catch (error) {
        errors.push(`${id}: ${error?.message ?? String(error)}`);
      }
    }
    if (normalizedPortable.length === PORTABLE_QUALITY_STORES.length) {
      const comparisonId = `portable-eval-${corpus}-comparison`;
      const comparison = comparePortableQualityArtifacts(normalizedPortable);
      if (!comparison.valid || identityHash(comparison) !== identityHash(record.artifacts?.[comparisonId])) errors.push(`${comparisonId}: summarized comparison differs from recomputed retained rankings`);
    }
  }
  return errors;
}

export function retainedQualitySummary(record) {
  return { schema: record.schema, measure_version: record.measure_version ?? MEASURE_VERSION, valid: record.valid, status: record.status, errors: record.errors, source: record.source ?? null };
}
