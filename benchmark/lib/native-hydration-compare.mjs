import { FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_SECTIONS } from './fixed-hydration-workload.mjs';
import { validateFixedWorkArtifact } from './fixed-work-measurement.mjs';
import { MEASURE_VERSION } from './measure.mjs';
import { identityHash } from './workload-identity.mjs';

const STORES = ['sqlite', 'duckdb', 'turso'];
export const NATIVE_HYDRATION_SCHEMA = 'native-hydration-v2';
export const NATIVE_HYDRATION_REPETITIONS = 3;
export const NATIVE_HYDRATION_HARNESS_FILES = [
  'benchmark/lib/canonical-json.mjs',
  'benchmark/lib/fixed-work-measurement.mjs',
  'benchmark/lib/fixed-hydration-workload.mjs',
  'benchmark/lib/measure.mjs',
  'benchmark/lib/native-capability.mjs',
  'benchmark/lib/native-hydration-compare.mjs',
  'benchmark/lib/out.mjs',
  'benchmark/lib/quiet-machine.mjs',
  'benchmark/lib/require-build.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/tools/native-hydration.mjs',
];

function same(actual, expected, label) {
  if (identityHash(actual) !== identityHash(expected)) throw new Error(`${label} mismatch`);
}

export function compareNativeHydrationArtifacts(artifacts) {
  const errors = [];
  const checked = [];
  for (const artifact of artifacts) {
    try {
      validateFixedWorkArtifact(artifact, { schema: NATIVE_HYDRATION_SCHEMA, repetitions: NATIVE_HYDRATION_REPETITIONS, harnessFiles: NATIVE_HYDRATION_HARNESS_FILES, store: artifact?.store });
      if (artifact.measure_version !== MEASURE_VERSION) throw new Error(`measure_version ${artifact.measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
      if (!STORES.includes(artifact.store)) throw new Error(`unexpected store ${artifact.store}`);
      if (artifact.case_id !== 'fixed-shapes-and-budgets') throw new Error('native hydration case identity mismatch');
      same(artifact.workload.inputs, { ...FIXED_HYDRATION_INPUTS, operation: 'production hydration over fixed ordered candidates and caller snippet budgets' }, `${artifact.store} fixed workload`);
      same(artifact.expected, { sections: FIXED_HYDRATION_SECTIONS, rows_by_case: FIXED_HYDRATION_EXPECTED }, `${artifact.store} authored expected output`);
      for (const sample of artifact.samples) {
        same(sample.candidate_order, artifact.workload.inputs.candidate_order, `${artifact.store} candidate order`);
        same(sample.rows_by_case, artifact.expected.rows_by_case, `${artifact.store} hydrated rows`);
        same(sample.sections, artifact.expected.sections, `${artifact.store} section rows`);
      }
      checked.push(artifact);
    } catch (error) {
      errors.push(`${artifact?.store ?? 'unknown'}: ${error?.message ?? error}`);
    }
  }
  const stores = checked.map(({ store }) => store).sort();
  if (identityHash(stores) !== identityHash([...STORES].sort())) errors.push(`store set must be ${STORES.join(', ')}`);
  if (checked.length === STORES.length) {
    const first = checked[0];
    for (const artifact of checked.slice(1)) {
      for (const [label, select] of [
        ['workload', (value) => value.workload],
        ['expected output', (value) => value.expected],
        ['environment', (value) => value.environment],
        ['measured package', (value) => value.provenance.measured_package],
        ['harness', (value) => value.provenance.harness],
        ['runtime', (value) => value.provenance.runtime],
      ]) {
        if (identityHash(select(artifact)) !== identityHash(select(first))) errors.push(`${label} differs between ${first.store} and ${artifact.store}`);
      }
    }
  }
  return {
    schema: 'native-hydration-comparison-v1',
    measure_version: checked[0]?.measure_version ?? null,
    status: errors.length === 0 ? 'success' : 'invalid',
    valid: errors.length === 0,
    errors,
    stores,
    scope: 'same fixed ordered candidates through production hydration; excludes ranking and native SQL content-read timing',
    ...(errors.length === 0 ? { workload: checked[0].workload, samples_ms_by_store: Object.fromEntries(checked.map((artifact) => [artifact.store, artifact.samples.map(({ ms }) => ms)])), median_ms_by_store: Object.fromEntries(checked.map((artifact) => [artifact.store, artifact.median_ms])) } : {}),
  };
}
