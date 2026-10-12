import type { FixedWorkArtifactInput } from './fixed-work-measurement.ts';
import { exitAboveAdmissionLimit, stableFixedWorkIdentity, validateFixedWorkArtifact } from './fixed-work-measurement.ts';
import { MEASURE_VERSION } from './measure.ts';
import { NATIVE_CAPABILITY_CASES } from './native-capability.ts';
import { identityHash } from './workload-identity.ts';

type FixedWorkInput = FixedWorkArtifactInput;
interface UpdateSample {
  repetition?: unknown;
  error?: unknown;
  ms?: unknown;
  changed_paths?: unknown;
  note_count?: unknown;
  initial_baseline_paths?: unknown;
  first_updated_paths?: unknown;
  warm_updated_paths?: unknown;
  post_update_baseline_paths?: unknown;
  open_ms?: unknown;
  first_lexical_ms?: unknown;
  warm_lexical_ms?: unknown;
}
interface UpdateInput extends FixedWorkInput {
  measure_version?: unknown;
  store?: string;
  changed?: number;
  expected?: { changed_paths?: unknown; notes?: unknown };
  samples?: UpdateSample[];
  provenance?: Parameters<typeof stableFixedWorkIdentity>[0];
}
interface EvidenceItem {
  kind: 'native-capability' | 'native-update';
  case_id?: string;
  changed?: number;
  notes: number;
  store: string;
}
interface EvidenceGroup extends Omit<EvidenceItem, 'store'> {
  id: string;
  stores: string[];
}
interface ComparisonInput {
  schema?: unknown;
  eligible?: unknown;
  reasons?: unknown[];
  status?: unknown;
  valid?: unknown;
  errors?: unknown[];
}
interface ErrorDetails {
  message?: unknown;
}
export const NATIVE_UPDATE_SCHEMA = 'native-update-threshold-v1';
export const NATIVE_UPDATE_COMPARISON_SCHEMA = 'native-update-threshold-comparison-v1';
export const NATIVE_UPDATE_NOTES = 260;
export const NATIVE_UPDATE_COUNTS = [249, 250, 251];
export const NATIVE_UPDATE_REPETITIONS = 3;
export const NATIVE_UPDATE_STORES = ['sqlite', 'duckdb', 'turso'];
export const NATIVE_UPDATE_MTIME_MS = Date.parse('2100-01-01T00:00:00.000Z');
export const NATIVE_UPDATE_NEXT_MTIME_MS = Date.parse('2100-01-01T00:01:00.000Z');
export const NATIVE_UPDATE_HARNESS_FILES = [
  'benchmark/lib/canonical-json.ts',
  'benchmark/lib/fixed-work-measurement.ts',
  'benchmark/lib/measure.ts',
  'benchmark/lib/native-capability.ts',
  'benchmark/lib/native-update-contract.ts',
  'benchmark/lib/out.ts',
  'benchmark/lib/quiet-machine.ts',
  'benchmark/lib/require-build.ts',
  'benchmark/lib/work-tree.ts',
  'benchmark/lib/workload-identity.ts',
  'benchmark/tools/native-update.ts',
];
export const NATIVE_UPDATE_NATIVE_PACKAGES: Record<string, string | null | undefined> = {
  sqlite: null,
  duckdb: '@duckdb/node-api',
  turso: '@tursodatabase/database',
};

export const nativeUpdatePath = (index: number) => `note-${String(index).padStart(3, '0')}.md`;
export const nativeUpdateText = (index: number, changed = false) => `# Note ${index}\n\nbaseline token ${index}${changed ? ' updated marker' : ''}\n`;
export const nativeUpdatePaths = (count: number) => Array.from({ length: count }, (_, index) => nativeUpdatePath(index));

export function nativeEvidenceSchedule(secondBaselineNotes: number): EvidenceItem[] {
  if (!Number.isSafeInteger(secondBaselineNotes) || secondBaselineNotes <= 4 || secondBaselineNotes > 50_000) throw new Error('second baseline note count must be an integer from 5 to 50000');
  return [
    ...NATIVE_CAPABILITY_CASES.flatMap((caseId) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability' as const, case_id: caseId, notes: caseId === 'structured-content' ? 5 : 4, store }))),
    ...NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability' as const, case_id: 'baseline', notes: secondBaselineNotes, store })),
    ...NATIVE_UPDATE_COUNTS.flatMap((changed) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-update' as const, changed, notes: NATIVE_UPDATE_NOTES, store }))),
  ];
}

export function nativeEvidenceExecutionPlan(secondBaselineNotes: number) {
  const producers = nativeEvidenceSchedule(secondBaselineNotes);
  const groups: EvidenceGroup[] = [];
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

export function nativeComparisonSucceeded(kind: string, comparison: unknown) {
  if (kind === 'native-capability')
    return (
      (comparison as Pick<ComparisonInput, 'schema'> | null | undefined)?.schema === 'native-capability-comparison-v1' &&
      (comparison as Pick<ComparisonInput, 'eligible'>).eligible === true &&
      Array.isArray((comparison as Pick<ComparisonInput, 'reasons'>).reasons) &&
      (comparison as { reasons: unknown[] }).reasons.length === 0
    );
  return (
    (comparison as Pick<ComparisonInput, 'schema'> | null | undefined)?.schema === NATIVE_UPDATE_COMPARISON_SCHEMA &&
    (comparison as Pick<ComparisonInput, 'status'>).status === 'success' &&
    (comparison as Pick<ComparisonInput, 'valid'>).valid === true &&
    Array.isArray((comparison as Pick<ComparisonInput, 'errors'>).errors) &&
    (comparison as { errors: unknown[] }).errors.length === 0
  );
}

export function nativeUpdateInputs(changed: number) {
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

function same(actual: unknown, expected: unknown, label: string) {
  if (identityHash(actual) !== identityHash(expected)) throw new Error(`${label} mismatch`);
}

export function compareNativeUpdateArtifacts(artifacts: readonly unknown[]) {
  const errors: string[] = [];
  const checked: unknown[] = [];
  for (const artifact of Array.isArray(artifacts) ? (artifacts as readonly unknown[]) : []) {
    try {
      validateFixedWorkArtifact(artifact, { schema: NATIVE_UPDATE_SCHEMA, repetitions: NATIVE_UPDATE_REPETITIONS, harnessFiles: NATIVE_UPDATE_HARNESS_FILES, store: (artifact as { store?: UpdateInput['store'] } | null | undefined)?.store });
      if (!Array.isArray((artifact as { errors: UpdateInput['errors'] }).errors) || ((artifact as { errors: UpdateInput['errors'] }).errors as unknown[]).length !== 0) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} successful artifact has nonempty errors`);
      if ((artifact as { measure_version: UpdateInput['measure_version'] }).measure_version !== MEASURE_VERSION) throw new Error(`measure_version ${(artifact as { measure_version: UpdateInput['measure_version'] }).measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
      if (!NATIVE_UPDATE_STORES.includes((artifact as { store: UpdateInput['store'] }).store as string)) throw new Error(`unexpected store ${(artifact as { store: UpdateInput['store'] }).store}`);
      if (!NATIVE_UPDATE_COUNTS.includes((artifact as { changed: UpdateInput['changed'] }).changed as number)) throw new Error(`unexpected changed-file count ${(artifact as { changed: UpdateInput['changed'] }).changed}`);
      same(((artifact as { workload: UpdateInput['workload'] }).workload as NonNullable<UpdateInput['workload']>).inputs, nativeUpdateInputs((artifact as { changed: UpdateInput['changed'] }).changed as number), `${(artifact as { store: UpdateInput['store'] }).store} workload`);
      same((artifact as { expected: UpdateInput['expected'] }).expected, { changed_paths: nativeUpdatePaths((artifact as { changed: UpdateInput['changed'] }).changed as number), notes: NATIVE_UPDATE_NOTES }, `${(artifact as { store: UpdateInput['store'] }).store} expected output`);
      const expectedBaseline = nativeUpdatePaths(NATIVE_UPDATE_NOTES);
      const expectedNativePackage = NATIVE_UPDATE_NATIVE_PACKAGES[(artifact as { store: UpdateInput['store'] }).store as string];
      if ((((artifact as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).native.package?.name ?? null) !== expectedNativePackage) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} native package identity is wrong`);
      for (const phase of ['entry', 'exit'])
        if (
          identityHash((((artifact as { readiness: UpdateInput['readiness'] }).readiness as NonNullable<UpdateInput['readiness']>).environment as NonNullable<NonNullable<UpdateInput['readiness']>['environment']>)[phase as 'entry' | 'exit']) !==
          identityHash((artifact as { environment: UpdateInput['environment'] }).environment)
        )
          throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} readiness ${phase} environment mismatch`);
      const stableIdentity = stableFixedWorkIdentity((artifact as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>, (artifact as { environment: UpdateInput['environment'] }).environment as NonNullable<UpdateInput['environment']>);
      if (
        identityHash(((artifact as { implementation_stability: UpdateInput['implementation_stability'] }).implementation_stability as NonNullable<UpdateInput['implementation_stability']>).before) !== identityHash(stableIdentity) ||
        identityHash(((artifact as { implementation_stability: UpdateInput['implementation_stability'] }).implementation_stability as NonNullable<UpdateInput['implementation_stability']>).after) !== identityHash(stableIdentity)
      )
        throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} implementation stability environment mismatch`);
      for (const sample of (artifact as { samples: UpdateInput['samples'] }).samples as UpdateSample[]) {
        same(sample.changed_paths, ((artifact as { expected: UpdateInput['expected'] }).expected as NonNullable<UpdateInput['expected']>).changed_paths, `${(artifact as { store: UpdateInput['store'] }).store} changed paths`);
        if (sample.note_count !== NATIVE_UPDATE_NOTES) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} note count mismatch`);
        for (const key of ['initial_baseline_paths', 'first_updated_paths', 'warm_updated_paths', 'post_update_baseline_paths'] as const) if (!Array.isArray(sample[key])) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} ${key} is missing`);
        if (identityHash(sample.initial_baseline_paths) !== identityHash(expectedBaseline) || identityHash(sample.post_update_baseline_paths) !== identityHash(expectedBaseline)) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} baseline lexical paths do not match all 260 notes`);
        if (
          identityHash(sample.first_updated_paths) !== identityHash(((artifact as { expected: UpdateInput['expected'] }).expected as NonNullable<UpdateInput['expected']>).changed_paths) ||
          identityHash(sample.warm_updated_paths) !== identityHash(((artifact as { expected: UpdateInput['expected'] }).expected as NonNullable<UpdateInput['expected']>).changed_paths)
        )
          throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} updated lexical paths do not match changed set`);
        const total = (sample.open_ms as number) + (sample.first_lexical_ms as number) + (sample.warm_lexical_ms as number);
        if (sample.ms !== total) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} timing total does not recompute`);
        for (const key of ['open_ms', 'first_lexical_ms', 'warm_lexical_ms'] as const) if (!(typeof sample[key] === 'number' && Number.isFinite(sample[key]) && sample[key] >= 0)) throw new Error(`${(artifact as { store: UpdateInput['store'] }).store} ${key} is invalid`);
      }
      checked.push(artifact);
    } catch (error) {
      errors.push(`${(artifact as { store?: UpdateInput['store'] } | null | undefined)?.store ?? 'unknown'}: ${(error as ErrorDetails | null | undefined)?.message ?? error}`);
    }
  }
  const stores = (checked as { store?: UpdateInput['store'] }[]).map(({ store }) => store).sort();
  if (identityHash(stores) !== identityHash([...NATIVE_UPDATE_STORES].sort())) errors.push(`store set must be ${NATIVE_UPDATE_STORES.join(', ')}`);
  if (new Set((checked as { changed?: UpdateInput['changed'] }[]).map(({ changed }) => changed)).size > 1) errors.push('changed-file count differs between stores');
  if (checked.length === NATIVE_UPDATE_STORES.length) {
    const first = checked[0];
    for (const artifact of checked.slice(1)) {
      for (const [label, value] of [
        ['workload', (artifact as { workload: UpdateInput['workload'] }).workload],
        ['expected output', (artifact as { expected: UpdateInput['expected'] }).expected],
        ['environment', (artifact as { environment: UpdateInput['environment'] }).environment],
        ['measured package', ((artifact as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).measured_package],
        ['harness', ((artifact as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).harness],
        ['runtime', ((artifact as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).runtime],
      ]) {
        const firstValue =
          label === 'workload'
            ? (first as { workload: UpdateInput['workload'] }).workload
            : label === 'expected output'
              ? (first as { expected: UpdateInput['expected'] }).expected
              : label === 'environment'
                ? (first as { environment: UpdateInput['environment'] }).environment
                : label === 'measured package'
                  ? ((first as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).measured_package
                  : label === 'harness'
                    ? ((first as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).harness
                    : ((first as { provenance: UpdateInput['provenance'] }).provenance as NonNullable<UpdateInput['provenance']>).runtime;
        if (identityHash(value) !== identityHash(firstValue)) errors.push(`${label} differs between ${(first as { store: UpdateInput['store'] }).store} and ${(artifact as { store: UpdateInput['store'] }).store}`);
      }
    }
  }
  // Readings judged by different readiness policies are never compared.
  for (const artifact of checked.slice(1))
    if (identityHash((artifact as { readiness?: { policy?: unknown } }).readiness?.policy) !== identityHash((checked[0] as { readiness?: { policy?: unknown } }).readiness?.policy))
      errors.push(`readiness policy differs between ${(checked[0] as { store: UpdateInput['store'] }).store} and ${(artifact as { store: UpdateInput['store'] }).store}`);
  // Stores whose exit reading was above the admission limit: their timings are observations, not clean
  // comparisons. Absent when there are none, so comparisons recorded before the policy change recompute.
  const exitAbove = errors.length === 0 ? checked.filter(exitAboveAdmissionLimit).map((artifact) => (artifact as { store: UpdateInput['store'] }).store as string) : [];
  return {
    schema: NATIVE_UPDATE_COMPARISON_SCHEMA,
    measure_version: (checked[0] as { measure_version?: unknown } | null | undefined)?.measure_version ?? null,
    status: errors.length === 0 ? 'success' : 'invalid',
    valid: errors.length === 0,
    errors,
    changed: (checked[0] as { changed?: unknown } | null | undefined)?.changed ?? null,
    stores,
    scope: 'identically prepared 260-note warm lexical updates around the 250-file churn threshold',
    ...(exitAbove.length > 0 ? { exit_load_above_admission_limit: exitAbove } : {}),
    ...(errors.length === 0
      ? {
          workload: (checked[0] as { workload: UpdateInput['workload'] }).workload,
          samples_ms_by_store: Object.fromEntries(
            checked.map(
              (artifact) =>
                [
                  (artifact as { store: UpdateInput['store'] }).store as string,
                  ((artifact as { samples: UpdateInput['samples'] }).samples as UpdateSample[]).map(({ open_ms, first_lexical_ms, warm_lexical_ms }) => ({ open_ms: open_ms as number, first_lexical_ms: first_lexical_ms as number, warm_lexical_ms: warm_lexical_ms as number })),
                ] as const
            )
          ),
        }
      : {}),
  };
}
