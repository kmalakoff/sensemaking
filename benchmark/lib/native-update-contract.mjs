import { stableFixedWorkIdentity, validateFixedWorkArtifact } from './fixed-work-measurement.mjs';
import { MEASURE_VERSION } from './measure.mjs';
import { NATIVE_CAPABILITY_CASES } from './native-capability.mjs';
import { identityHash } from './workload-identity.mjs';

export const NATIVE_UPDATE_SCHEMA = 'native-update-threshold-v1';
export const NATIVE_UPDATE_COMPARISON_SCHEMA = 'native-update-threshold-comparison-v1';
export const NATIVE_UPDATE_NOTES = 260;
export const NATIVE_UPDATE_COUNTS = [249, 250, 251];
export const NATIVE_UPDATE_REPETITIONS = 3;
export const NATIVE_UPDATE_STORES = ['sqlite', 'duckdb', 'turso'];
export const NATIVE_UPDATE_MTIME_MS = Date.parse('2100-01-01T00:00:00.000Z');
export const NATIVE_UPDATE_NEXT_MTIME_MS = Date.parse('2100-01-01T00:01:00.000Z');
export const NATIVE_UPDATE_HARNESS_FILES = [
  'benchmark/lib/canonical-json.mjs',
  'benchmark/lib/fixed-work-measurement.mjs',
  'benchmark/lib/measure.mjs',
  'benchmark/lib/native-capability.mjs',
  'benchmark/lib/native-update-contract.mjs',
  'benchmark/lib/out.mjs',
  'benchmark/lib/quiet-machine.mjs',
  'benchmark/lib/require-build.mjs',
  'benchmark/lib/work-tree.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/tools/native-update.mjs',
];
export const NATIVE_UPDATE_NATIVE_PACKAGES = {
  sqlite: null,
  duckdb: '@duckdb/node-api',
  turso: '@tursodatabase/database',
};

export const nativeUpdatePath = (index) => `note-${String(index).padStart(3, '0')}.md`;
export const nativeUpdateText = (index, changed = false) => `# Note ${index}\n\nbaseline token ${index}${changed ? ' updated marker' : ''}\n`;
export const nativeUpdatePaths = (count) => Array.from({ length: count }, (_, index) => nativeUpdatePath(index));

export function nativeEvidenceSchedule(secondBaselineNotes) {
  if (!Number.isSafeInteger(secondBaselineNotes) || secondBaselineNotes <= 4 || secondBaselineNotes > 50_000) throw new Error('second baseline note count must be an integer from 5 to 50000');
  return [
    ...NATIVE_CAPABILITY_CASES.flatMap((caseId) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability', case_id: caseId, notes: caseId === 'structured-content' ? 5 : 4, store }))),
    ...NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability', case_id: 'baseline', notes: secondBaselineNotes, store })),
    ...NATIVE_UPDATE_COUNTS.flatMap((changed) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-update', changed, notes: NATIVE_UPDATE_NOTES, store }))),
  ];
}

export function nativeEvidenceExecutionPlan(secondBaselineNotes) {
  const producers = nativeEvidenceSchedule(secondBaselineNotes);
  const groups = [];
  for (const item of producers) {
    const id = item.kind === 'native-capability' ? `capability-${item.case_id}-${item.notes}` : `update-${item.changed}`;
    let group = groups.find(({ id: groupId }) => groupId === id);
    if (!group) {
      group = { id, kind: item.kind, case_id: item.case_id, changed: item.changed, notes: item.notes, stores: [] };
      groups.push(group);
    }
    group.stores.push(item.store);
  }
  const comparators = groups.map((group) => ({
    ...group,
    artifact_files: group.stores.map((store) => `${group.id}-${store}.json`),
    comparison_file: `${group.id}-comparison.json`,
  }));
  const files = comparators.flatMap((group) => [...group.artifact_files, group.comparison_file]);
  if (new Set(files).size !== files.length) throw new Error('native evidence plan has duplicate output paths');
  return { producers, comparators };
}

export function nativeComparisonSucceeded(kind, comparison) {
  if (kind === 'native-capability') return comparison?.schema === 'native-capability-comparison-v1' && comparison.eligible === true && Array.isArray(comparison.reasons) && comparison.reasons.length === 0;
  return comparison?.schema === NATIVE_UPDATE_COMPARISON_SCHEMA && comparison.status === 'success' && comparison.valid === true && Array.isArray(comparison.errors) && comparison.errors.length === 0;
}

export function nativeUpdateInputs(changed) {
  if (!NATIVE_UPDATE_COUNTS.includes(changed)) throw new Error(`changed files must be one of ${NATIVE_UPDATE_COUNTS.join(', ')}`);
  const paths = nativeUpdatePaths(NATIVE_UPDATE_NOTES);
  const baselineCorpus = paths.map((path, index) => ({ path, text: nativeUpdateText(index), mtime_ms: NATIVE_UPDATE_MTIME_MS }));
  const changedCorpus = paths.map((path, index) => ({ path, text: nativeUpdateText(index, index < changed), mtime_ms: index < changed ? NATIVE_UPDATE_NEXT_MTIME_MS : NATIVE_UPDATE_MTIME_MS }));
  const queryOptions = { whereJoin: '', whereCond: '', scopeCond: '', limit: NATIVE_UPDATE_NOTES };
  const config = { presets: { default: { include: ['**/*.md'] } }, queries: {}, configPath: null, baseDir: '<temporary-authored-corpus>' };
  return {
    operation: 'warm native lexical update after deterministic content changes',
    notes: NATIVE_UPDATE_NOTES,
    changed,
    changed_paths: nativeUpdatePaths(changed),
    initial_mtime_ms: NATIVE_UPDATE_MTIME_MS,
    changed_mtime_ms: NATIVE_UPDATE_NEXT_MTIME_MS,
    corpus: {
      notes: NATIVE_UPDATE_NOTES,
      baseline: { fingerprint: identityHash(baselineCorpus), files: baselineCorpus },
      changed: { fingerprint: identityHash(changedCorpus), files: changedCorpus },
    },
    config,
    queries: {
      baseline: { text: 'baseline', options: queryOptions },
      changed: { text: 'updated', options: queryOptions },
    },
    initial_lexical_state: 'built and queried once before close',
    measured_lexical_state: 'first and second queries after the measured update open',
  };
}

function same(actual, expected, label) {
  if (identityHash(actual) !== identityHash(expected)) throw new Error(`${label} mismatch`);
}

export function compareNativeUpdateArtifacts(artifacts) {
  const errors = [];
  const checked = [];
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    try {
      validateFixedWorkArtifact(artifact, { schema: NATIVE_UPDATE_SCHEMA, repetitions: NATIVE_UPDATE_REPETITIONS, harnessFiles: NATIVE_UPDATE_HARNESS_FILES, store: artifact?.store });
      if (!Array.isArray(artifact.errors) || artifact.errors.length !== 0) throw new Error(`${artifact.store} successful artifact has nonempty errors`);
      if (artifact.measure_version !== MEASURE_VERSION) throw new Error(`measure_version ${artifact.measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
      if (!NATIVE_UPDATE_STORES.includes(artifact.store)) throw new Error(`unexpected store ${artifact.store}`);
      if (!NATIVE_UPDATE_COUNTS.includes(artifact.changed)) throw new Error(`unexpected changed-file count ${artifact.changed}`);
      same(artifact.workload.inputs, nativeUpdateInputs(artifact.changed), `${artifact.store} workload`);
      same(artifact.expected, { changed_paths: nativeUpdatePaths(artifact.changed), notes: NATIVE_UPDATE_NOTES }, `${artifact.store} expected output`);
      const expectedBaseline = nativeUpdatePaths(NATIVE_UPDATE_NOTES);
      const expectedNativePackage = NATIVE_UPDATE_NATIVE_PACKAGES[artifact.store];
      if ((artifact.provenance.native.package?.name ?? null) !== expectedNativePackage) throw new Error(`${artifact.store} native package identity is wrong`);
      for (const phase of ['entry', 'exit']) if (identityHash(artifact.readiness.environment[phase]) !== identityHash(artifact.environment)) throw new Error(`${artifact.store} readiness ${phase} environment mismatch`);
      const stableIdentity = stableFixedWorkIdentity(artifact.provenance, artifact.environment);
      if (identityHash(artifact.implementation_stability.before) !== identityHash(stableIdentity) || identityHash(artifact.implementation_stability.after) !== identityHash(stableIdentity)) throw new Error(`${artifact.store} implementation stability environment mismatch`);
      for (const sample of artifact.samples) {
        same(sample.changed_paths, artifact.expected.changed_paths, `${artifact.store} changed paths`);
        if (sample.note_count !== NATIVE_UPDATE_NOTES) throw new Error(`${artifact.store} note count mismatch`);
        for (const key of ['initial_baseline_paths', 'first_updated_paths', 'warm_updated_paths', 'post_update_baseline_paths']) if (!Array.isArray(sample[key])) throw new Error(`${artifact.store} ${key} is missing`);
        if (identityHash(sample.initial_baseline_paths) !== identityHash(expectedBaseline) || identityHash(sample.post_update_baseline_paths) !== identityHash(expectedBaseline)) throw new Error(`${artifact.store} baseline lexical paths do not match all 260 notes`);
        if (identityHash(sample.first_updated_paths) !== identityHash(artifact.expected.changed_paths) || identityHash(sample.warm_updated_paths) !== identityHash(artifact.expected.changed_paths)) throw new Error(`${artifact.store} updated lexical paths do not match changed set`);
        const total = sample.open_ms + sample.first_lexical_ms + sample.warm_lexical_ms;
        if (sample.ms !== total) throw new Error(`${artifact.store} timing total does not recompute`);
        for (const key of ['open_ms', 'first_lexical_ms', 'warm_lexical_ms']) if (!(typeof sample[key] === 'number' && Number.isFinite(sample[key]) && sample[key] >= 0)) throw new Error(`${artifact.store} ${key} is invalid`);
      }
      checked.push(artifact);
    } catch (error) {
      errors.push(`${artifact?.store ?? 'unknown'}: ${error?.message ?? error}`);
    }
  }
  const stores = checked.map(({ store }) => store).sort();
  if (identityHash(stores) !== identityHash([...NATIVE_UPDATE_STORES].sort())) errors.push(`store set must be ${NATIVE_UPDATE_STORES.join(', ')}`);
  if (new Set(checked.map(({ changed }) => changed)).size > 1) errors.push('changed-file count differs between stores');
  if (checked.length === NATIVE_UPDATE_STORES.length) {
    const first = checked[0];
    for (const artifact of checked.slice(1)) {
      for (const [label, value] of [
        ['workload', artifact.workload],
        ['expected output', artifact.expected],
        ['environment', artifact.environment],
        ['measured package', artifact.provenance.measured_package],
        ['harness', artifact.provenance.harness],
        ['runtime', artifact.provenance.runtime],
      ]) {
        const firstValue = label === 'workload' ? first.workload : label === 'expected output' ? first.expected : label === 'environment' ? first.environment : label === 'measured package' ? first.provenance.measured_package : label === 'harness' ? first.provenance.harness : first.provenance.runtime;
        if (identityHash(value) !== identityHash(firstValue)) errors.push(`${label} differs between ${first.store} and ${artifact.store}`);
      }
    }
  }
  return {
    schema: NATIVE_UPDATE_COMPARISON_SCHEMA,
    measure_version: checked[0]?.measure_version ?? null,
    status: errors.length === 0 ? 'success' : 'invalid',
    valid: errors.length === 0,
    errors,
    changed: checked[0]?.changed ?? null,
    stores,
    scope: 'identically prepared 260-note warm lexical updates around the 250-file churn threshold',
    ...(errors.length === 0
      ? {
          workload: checked[0].workload,
          samples_ms_by_store: Object.fromEntries(checked.map((artifact) => [artifact.store, artifact.samples.map(({ open_ms, first_lexical_ms, warm_lexical_ms }) => ({ open_ms, first_lexical_ms, warm_lexical_ms }))])),
        }
      : {}),
  };
}
