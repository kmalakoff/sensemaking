import { STORE_NAMES } from 'sensemaking';
import { MEASURE_VERSION } from './measure.ts';
import type { QualityMetrics } from './metrics.ts';
import { metrics, rankingInputError } from './metrics.ts';
import { identityHash, logicalConfig } from './workload-identity.ts';

type Fields = Record<string, unknown>;
type IdentityInputs = { inputs: Fields & { requested: Fields } };
type MutableVariants = { variants: Record<string, Fields & { per_query: Record<string, Fields> }> };
interface ValidationOptions {
  store: string;
  queryForm?: string;
}
interface Revalidation {
  errors: string[];
  artifact: unknown;
}

export const PORTABLE_QUALITY_SCHEMA = 'portable-quality-comparison-v1';
export const PORTABLE_QUALITY_STORES = [...STORE_NAMES];
export const PORTABLE_QUALITY_VARIANTS = ['bm25-only', 'fused', 'semantic'];
export const PORTABLE_QUALITY_QUERY_FORM = 'bare-and';

const isObject = (value: unknown): value is Fields => value !== null && typeof value === 'object' && !Array.isArray(value);
const finiteMetric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const METRICS = ['ndcg', 'rr', 'hit'] as const;

function workloadPart(artifact: Fields) {
  return {
    corpus: artifact.corpus,
    split: artifact.split,
    queries: artifact.queries,
    k: artifact.k,
    query_form: artifact.query_form,
    query_evidence: artifact.query_evidence,
    qrels: artifact.qrels,
  };
}

function qrelsMap(labels: Fields) {
  return new Map(Object.entries(labels));
}

function logicalResultId(path: string) {
  return path.replace(/\.md$/, '');
}

function expectedOperation(artifact: Fields) {
  return {
    kind: 'quality',
    corpus: artifact.corpus,
    split: artifact.split,
    k: artifact.k,
    query_form: artifact.query_form,
    query_evidence: artifact.query_evidence,
    qrels: artifact.qrels,
  };
}

function comparableIdentity(identity: IdentityInputs) {
  const inputs = { ...identity.inputs, requested: { ...identity.inputs.requested, config: logicalConfig(identity.inputs.requested.config) } };
  return { ...identity, fingerprint: identityHash(inputs), inputs };
}

function validateIdentity(identity: unknown, variantName: string, artifact: Fields, variant: Fields) {
  const errors: string[] = [];
  if (!isObject(identity) || typeof identity.fingerprint !== 'string' || !Object.hasOwn(identity, 'inputs')) return [`${variantName}: workload identity is missing or invalid`];
  if (!isObject(identity.inputs) || identity.fingerprint !== identityHash(identity.inputs)) errors.push(`${variantName}: workload identity is missing or invalid`);
  const inputs = identity.inputs;
  if (!isObject(inputs)) return errors;
  if (!isObject(inputs.operation) || identityHash(inputs.operation) !== identityHash(expectedOperation(artifact))) errors.push(`${variantName}: workload identity does not match recorded query/corpus evidence`);
  if (!isObject(inputs.requested) || inputs.requested.variant !== variantName) errors.push(`${variantName}: workload identity does not identify the recorded variant`);
  const requestedConfig = logicalConfig((inputs.requested as { config?: unknown } | null | undefined)?.config);
  const executionConfig = logicalConfig((variant.execution as { config?: unknown } | null | undefined)?.config);
  if (!requestedConfig || !executionConfig || identityHash(requestedConfig) !== identityHash(executionConfig)) errors.push(`${variantName}: workload identity does not match recorded configuration`);
  return errors;
}

function validateArtifact(artifact: unknown, expectedStore: string, expectedQueryForm?: string, options?: { recompute?: false }): string[];
function validateArtifact(artifact: unknown, expectedStore: string, expectedQueryForm: string, options: { recompute: true }): string[] | Revalidation;
function validateArtifact(artifact: unknown, expectedStore: string, expectedQueryForm = PORTABLE_QUALITY_QUERY_FORM, { recompute = false } = {}) {
  const errors: string[] = [];
  const normalized: unknown = recompute && isObject(artifact) ? JSON.parse(JSON.stringify(artifact)) : artifact;
  if (!isObject(artifact)) return recompute ? { errors: ['artifact is not an object'], artifact: null } : ['artifact is not an object'];
  if (artifact.measure_version !== MEASURE_VERSION) errors.push(`measure_version ${artifact.measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
  if (artifact.store !== expectedStore) errors.push(`store is ${artifact.store ?? 'missing'}, expected ${expectedStore}`);
  if (artifact.query_form !== expectedQueryForm) errors.push(`query_form is ${artifact.query_form ?? 'missing'}, expected ${expectedQueryForm}`);
  if (artifact.error || artifact.incomplete === true) errors.push(`artifact is incomplete${artifact.error ? `: ${artifact.error}` : ''}`);
  if (typeof artifact.corpus !== 'string' || typeof artifact.split !== 'string' || !Number.isSafeInteger(artifact.queries) || (artifact.queries as number) < 1 || !Number.isSafeInteger(artifact.k) || (artifact.k as number) < 1) errors.push('corpus, split, queries, and k are incomplete');
  if (!isObject(artifact.query_evidence) || !isObject(artifact.qrels)) errors.push('query evidence or qrels are missing');
  const qids = isObject(artifact.query_evidence) ? Object.keys(artifact.query_evidence).sort() : [];
  const qrelIds = isObject(artifact.qrels) ? Object.keys(artifact.qrels).sort() : [];
  if (qids.length !== artifact.queries || identityHash(qids) !== identityHash(qrelIds)) errors.push('query evidence and qrels do not cover the same query IDs');
  for (const qid of qids) {
    const evidence = (artifact.query_evidence as Fields)[qid];
    const labels = (artifact.qrels as Fields)[qid];
    if (!isObject(evidence) || typeof evidence.text !== 'string' || evidence.text.trim().length === 0 || typeof evidence.canonical !== 'string' || evidence.canonical.trim().length === 0) errors.push(`${qid}: query evidence is incomplete`);
    if (!isObject(labels) || Object.values(labels).some((label) => typeof label !== 'number' || !Number.isFinite(label))) errors.push(`${qid}: qrels are incomplete`);
  }
  if (!isObject(artifact.variants)) {
    errors.push('variants are missing');
    return errors;
  }
  if (identityHash(Object.keys(artifact.variants).sort()) !== identityHash([...PORTABLE_QUALITY_VARIANTS].sort())) errors.push(`variants must be ${PORTABLE_QUALITY_VARIANTS.join(', ')}`);
  for (const name of PORTABLE_QUALITY_VARIANTS) {
    const variant = artifact.variants[name];
    if (!isObject(variant)) {
      errors.push(`${name}: variant is missing`);
      continue;
    }
    if (variant.errors !== 0 || variant.incomplete === true) errors.push(`${name}: retrieval is incomplete (${variant.errors ?? 'missing'} error(s))`);
    const identityErrors = validateIdentity(variant.workload_identity, name, artifact, variant);
    errors.push(...identityErrors);
    if (recompute && identityErrors.length === 0) (normalized as MutableVariants).variants[name].workload_identity = comparableIdentity(variant.workload_identity as IdentityInputs);
    if (!isObject(variant.per_query)) {
      errors.push(`${name}: per_query evidence is missing`);
      continue;
    }
    const resultIds = Object.keys(variant.per_query).sort();
    if (identityHash(resultIds) !== identityHash(qids)) errors.push(`${name}: per_query coverage differs from qrels`);
    const recomputedMetrics: QualityMetrics[] = [];
    for (const qid of qids) {
      const result = variant.per_query[qid];
      if (!isObject(result) || !Array.isArray(result.paths)) {
        errors.push(`${name}/${qid}: returned paths are missing`);
        continue;
      }
      if (result.paths.length > (artifact.k as number)) errors.push(`${name}/${qid}: returned ${result.paths.length} paths, more than k=${artifact.k}`);
      const ranked = result.paths.map((path: unknown) => (typeof path === 'string' ? logicalResultId(path) : path));
      const rawLabels = isObject(artifact.qrels) ? (artifact.qrels as Fields)[qid] : undefined;
      if (!isObject(rawLabels)) {
        errors.push(`${name}/${qid}: qrels are missing`);
        continue;
      }
      if (Object.keys(rawLabels).length === 0) {
        errors.push(`${name}/${qid}: qrels contain no judged documents`);
        continue;
      }
      const labels = qrelsMap(rawLabels);
      const rankingError = rankingInputError(ranked, labels, artifact.k as number);
      if (rankingError) errors.push(`${name}/${qid}: ${rankingError}`);
      let recomputed: QualityMetrics | undefined;
      if (!rankingError) {
        try {
          recomputed = metrics(ranked as string[], labels as ReadonlyMap<string, number>, artifact.k as number);
        } catch (error) {
          errors.push(`${name}/${qid}: ${(error as { message?: unknown } | null)?.message ?? String(error)}`);
        }
      }
      for (const metric of METRICS) {
        if (!finiteMetric(result[metric])) errors.push(`${name}/${qid}: ${metric} is missing or out of range`);
        if (recomputed) {
          if (!recompute && result[metric] !== recomputed[metric]) errors.push(`${name}/${qid}: recorded ${metric} ${result[metric]} does not match recomputed ${recomputed[metric]}`);
          if (recompute) (normalized as MutableVariants).variants[name].per_query[qid][metric] = recomputed[metric];
        }
      }
      if (recomputed) recomputedMetrics.push(recomputed);
    }
    for (const metric of METRICS) {
      const aggregate = recomputedMetrics.reduce((total, result) => total + result[metric], 0) / qids.length;
      if (!finiteMetric(variant[metric])) errors.push(`${name}: aggregate ${metric} is missing or out of range`);
      else if (!recompute && variant[metric] !== aggregate) errors.push(`${name}: aggregate ${metric} ${variant[metric]} does not match recomputed ${aggregate}`);
      if (recompute && Number.isFinite(aggregate)) (normalized as MutableVariants).variants[name][metric] = aggregate;
    }
  }
  return recompute ? { errors, artifact: normalized } : errors;
}

export function validateQualityArtifact(artifact: unknown, { store, queryForm = PORTABLE_QUALITY_QUERY_FORM }: ValidationOptions) {
  return validateArtifact(artifact, store, queryForm);
}

export function revalidateQualityArtifact(artifact: unknown, { store, queryForm = PORTABLE_QUALITY_QUERY_FORM }: ValidationOptions) {
  return validateArtifact(artifact, store, queryForm, { recompute: true });
}

export function comparePortableQualityArtifacts(artifacts: readonly unknown[]) {
  const errors: string[] = [];
  const checked: Fields[] = [];
  for (const store of PORTABLE_QUALITY_STORES) {
    const artifact = artifacts.find((candidate) => (candidate as { store?: unknown } | null)?.store === store);
    if (!artifact) {
      errors.push(`${store}: artifact is missing`);
      continue;
    }
    const artifactErrors = validateArtifact(artifact, store);
    if (artifactErrors.length > 0) errors.push(`${store}: ${artifactErrors.join('; ')}`);
    else checked.push(artifact as Fields);
  }
  const stores = checked.map((artifact) => artifact.store).sort();
  if (artifacts.length !== PORTABLE_QUALITY_STORES.length) errors.push(`artifact set must contain exactly ${PORTABLE_QUALITY_STORES.join(', ')}`);
  if (checked.length === PORTABLE_QUALITY_STORES.length) {
    const first = checked[0];
    const expected = workloadPart(first);
    for (const artifact of checked.slice(1)) if (identityHash(workloadPart(artifact)) !== identityHash(expected)) errors.push(`workload differs between ${first.store} and ${artifact.store}`);
    for (const variant of PORTABLE_QUALITY_VARIANTS) {
      const expectedIdentity = comparableIdentity((first.variants as Record<string, { workload_identity: IdentityInputs }>)[variant].workload_identity);
      for (const artifact of checked.slice(1))
        if (identityHash(comparableIdentity((artifact.variants as Record<string, { workload_identity: IdentityInputs }>)[variant].workload_identity)) !== identityHash(expectedIdentity)) errors.push(`${variant}: workload identity differs between ${first.store} and ${artifact.store}`);
    }
  }
  return {
    schema: PORTABLE_QUALITY_SCHEMA,
    measure_version: artifacts.length > 0 && artifacts.every((artifact) => (artifact as { measure_version?: unknown } | null)?.measure_version === (artifacts[0] as { measure_version?: unknown } | null)?.measure_version) ? ((artifacts[0] as { measure_version?: unknown } | null)?.measure_version ?? null) : null,
    status: errors.length === 0 ? 'success' : 'invalid',
    valid: errors.length === 0,
    errors,
    stores,
    query_form: PORTABLE_QUALITY_QUERY_FORM,
    ...(errors.length === 0
      ? { workload: workloadPart(checked[0]), coverage: Object.fromEntries(checked.map((artifact) => [artifact.store, Object.fromEntries(PORTABLE_QUALITY_VARIANTS.map((variant) => [variant, Object.keys((artifact.variants as Record<string, { per_query: Fields }>)[variant].per_query).length]))])) }
      : {}),
  };
}
