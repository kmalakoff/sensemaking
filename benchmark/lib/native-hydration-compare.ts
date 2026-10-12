import { FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_SECTIONS } from './fixed-hydration-workload.ts';
import type { FixedWorkArtifactInput } from './fixed-work-measurement.ts';
import { exitAboveAdmissionLimit, validateFixedWorkArtifact } from './fixed-work-measurement.ts';
import { MEASURE_VERSION } from './measure.ts';
import { identityHash } from './workload-identity.ts';

type FixedWorkInput = FixedWorkArtifactInput;
interface HydrationSample {
  repetition?: unknown;
  error?: unknown;
  ms?: unknown;
  candidate_order?: unknown;
  rows_by_case?: unknown;
  sections?: unknown;
}
interface HydrationInput extends FixedWorkInput {
  measure_version?: unknown;
  store?: string;
  case_id?: unknown;
  workload?: { fingerprint?: unknown; inputs?: { candidate_order?: unknown } };
  expected?: { sections?: unknown; rows_by_case?: unknown };
  samples?: HydrationSample[];
}
interface ErrorDetails {
  message?: unknown;
}
const STORES = ['sqlite', 'duckdb', 'turso'];
export const NATIVE_HYDRATION_SCHEMA = 'native-hydration-v2';
export const NATIVE_HYDRATION_REPETITIONS = 3;
export const NATIVE_HYDRATION_HARNESS_FILES = [
  'benchmark/lib/canonical-json.ts',
  'benchmark/lib/fixed-work-measurement.ts',
  'benchmark/lib/fixed-hydration-workload.ts',
  'benchmark/lib/measure.ts',
  'benchmark/lib/native-capability.ts',
  'benchmark/lib/native-hydration-compare.ts',
  'benchmark/lib/out.ts',
  'benchmark/lib/quiet-machine.ts',
  'benchmark/lib/require-build.ts',
  'benchmark/lib/workload-identity.ts',
  'benchmark/tools/native-hydration.ts',
];

function same(actual: unknown, expected: unknown, label: string) {
  if (identityHash(actual) !== identityHash(expected)) throw new Error(`${label} mismatch`);
}

export function compareNativeHydrationArtifacts(artifacts: readonly unknown[]) {
  const errors: string[] = [];
  const checked: unknown[] = [];
  for (const artifact of artifacts) {
    try {
      validateFixedWorkArtifact(artifact, { schema: NATIVE_HYDRATION_SCHEMA, repetitions: NATIVE_HYDRATION_REPETITIONS, harnessFiles: NATIVE_HYDRATION_HARNESS_FILES, store: (artifact as { store?: HydrationInput['store'] } | null | undefined)?.store });
      if ((artifact as { measure_version: HydrationInput['measure_version'] }).measure_version !== MEASURE_VERSION) throw new Error(`measure_version ${(artifact as { measure_version: HydrationInput['measure_version'] }).measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
      if (!STORES.includes((artifact as { store: HydrationInput['store'] }).store as string)) throw new Error(`unexpected store ${(artifact as { store: HydrationInput['store'] }).store}`);
      if ((artifact as { case_id: HydrationInput['case_id'] }).case_id !== 'fixed-shapes-and-budgets') throw new Error('native hydration case identity mismatch');
      same(
        ((artifact as { workload: HydrationInput['workload'] }).workload as NonNullable<HydrationInput['workload']>).inputs,
        { ...FIXED_HYDRATION_INPUTS, operation: 'production hydration over fixed ordered candidates and caller snippet budgets' },
        `${(artifact as { store: HydrationInput['store'] }).store} fixed workload`
      );
      same((artifact as { expected: HydrationInput['expected'] }).expected, { sections: FIXED_HYDRATION_SECTIONS, rows_by_case: FIXED_HYDRATION_EXPECTED }, `${(artifact as { store: HydrationInput['store'] }).store} authored expected output`);
      for (const sample of (artifact as { samples: HydrationInput['samples'] }).samples as HydrationSample[]) {
        same(sample.candidate_order, (((artifact as { workload: HydrationInput['workload'] }).workload as NonNullable<HydrationInput['workload']>).inputs as NonNullable<NonNullable<HydrationInput['workload']>['inputs']>).candidate_order, `${(artifact as { store: HydrationInput['store'] }).store} candidate order`);
        same(sample.rows_by_case, ((artifact as { expected: HydrationInput['expected'] }).expected as NonNullable<HydrationInput['expected']>).rows_by_case, `${(artifact as { store: HydrationInput['store'] }).store} hydrated rows`);
        same(sample.sections, ((artifact as { expected: HydrationInput['expected'] }).expected as NonNullable<HydrationInput['expected']>).sections, `${(artifact as { store: HydrationInput['store'] }).store} section rows`);
      }
      checked.push(artifact);
    } catch (error) {
      errors.push(`${(artifact as { store?: HydrationInput['store'] } | null | undefined)?.store ?? 'unknown'}: ${(error as ErrorDetails | null | undefined)?.message ?? error}`);
    }
  }
  const stores = (checked as { store?: HydrationInput['store'] }[]).map(({ store }) => store).sort();
  if (identityHash(stores) !== identityHash([...STORES].sort())) errors.push(`store set must be ${STORES.join(', ')}`);
  if (checked.length === STORES.length) {
    const first = checked[0];
    for (const artifact of checked.slice(1)) {
      for (const [label, select] of [
        ['workload', (value: unknown) => (value as { workload: HydrationInput['workload'] }).workload],
        ['expected output', (value: unknown) => (value as { expected: HydrationInput['expected'] }).expected],
        ['environment', (value: unknown) => (value as { environment: HydrationInput['environment'] }).environment],
        ['measured package', (value: unknown) => ((value as { provenance: HydrationInput['provenance'] }).provenance as NonNullable<HydrationInput['provenance']>).measured_package],
        ['harness', (value: unknown) => ((value as { provenance: HydrationInput['provenance'] }).provenance as NonNullable<HydrationInput['provenance']>).harness],
        ['runtime', (value: unknown) => ((value as { provenance: HydrationInput['provenance'] }).provenance as NonNullable<HydrationInput['provenance']>).runtime],
        ['readiness policy', (value: unknown) => (value as { readiness?: { policy?: unknown } }).readiness?.policy],
      ] as const) {
        if (identityHash(select(artifact)) !== identityHash(select(first))) errors.push(`${label} differs between ${(first as { store: HydrationInput['store'] }).store} and ${(artifact as { store: HydrationInput['store'] }).store}`);
      }
    }
  }
  // Stores whose exit reading was above the admission limit: their timings are observations, not clean
  // comparisons. Absent when there are none, so comparisons recorded before the policy change recompute.
  const exitAbove = errors.length === 0 ? checked.filter(exitAboveAdmissionLimit).map((artifact) => (artifact as { store: HydrationInput['store'] }).store as string) : [];
  return {
    schema: 'native-hydration-comparison-v1',
    measure_version: (checked[0] as { measure_version?: unknown } | null | undefined)?.measure_version ?? null,
    status: errors.length === 0 ? 'success' : 'invalid',
    valid: errors.length === 0,
    errors,
    stores,
    scope: 'same fixed ordered candidates through production hydration; excludes ranking and native SQL content-read timing',
    ...(exitAbove.length > 0 ? { exit_load_above_admission_limit: exitAbove } : {}),
    ...(errors.length === 0
      ? {
          workload: (checked[0] as { workload: HydrationInput['workload'] }).workload,
          samples_ms_by_store: Object.fromEntries(checked.map((artifact) => [(artifact as { store: HydrationInput['store'] }).store as string, ((artifact as { samples: HydrationInput['samples'] }).samples as HydrationSample[]).map(({ ms }) => ms as number)] as const)),
          median_ms_by_store: Object.fromEntries(checked.map((artifact) => [(artifact as { store: HydrationInput['store'] }).store as string, (artifact as { median_ms: HydrationInput['median_ms'] }).median_ms as number] as const)),
        }
      : {}),
  };
}
