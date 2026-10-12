// Fail-closed comparison preflight for the standalone native-capability diagnostic. This does
// not classify performance, change a gate, or equate fixed-path SQL reads with search hydration.

import { MEASURE_VERSION } from './measure.ts';
import type { runNativeCapability } from './native-capability.ts';
import {
  checkReadinessReading,
  MAX_NATIVE_NOTES,
  MAX_NATIVE_REPETITIONS,
  NATIVE_CAPABILITY_HARNESS_FILES,
  NATIVE_CAPABILITY_METHOD_VERSION,
  NATIVE_CAPABILITY_READINESS_POLICY,
  NATIVE_CAPABILITY_ROWS,
  NATIVE_CAPABILITY_SCHEMA,
  NATIVE_CAPABILITY_VECTOR_DIMS,
  nativeCapabilityContract,
  readinessRule,
} from './native-capability.ts';
import { identityHash } from './workload-identity.ts';

type Contract = ReturnType<typeof nativeCapabilityContract>;
type Producer = Awaited<ReturnType<typeof runNativeCapability>>;
type ProducerEnvironment = Producer['environment'];
interface NativeCandidate {
  version_query?: unknown;
  capabilities?: unknown;
  version?: unknown;
  engine_status?: unknown;
}
interface FileIdentity {
  status?: unknown;
  files?: number;
  fingerprint?: string;
}
interface MeasuredPackage {
  name?: unknown;
  version?: unknown;
  package_json?: FileIdentity;
  dist?: FileIdentity;
  source?: FileIdentity;
}
interface ProvenanceCandidate {
  measured_package?: MeasuredPackage;
  harness?: { files?: number; fingerprint?: string; paths?: unknown };
  runtime?: { node?: unknown };
  native?: { store?: unknown; observation?: NativeCandidate | null; package?: { name?: unknown; version?: unknown } | null };
  model?: unknown;
}
interface EnvironmentCandidate {
  observation?: unknown;
  machine?: { [K in keyof ProducerEnvironment['machine']]?: ProducerEnvironment['machine'][K] };
  machine_fingerprint?: unknown;
  runtime?: { node?: unknown };
}
interface LoadCandidate {
  load1?: number;
  load5?: number;
  load15?: number;
  supported?: unknown;
  passed?: unknown;
}
interface ReadinessCandidate {
  policy?: unknown;
  environment?: { entry?: EnvironmentCandidate | null; exit?: EnvironmentCandidate | null };
  entry?: LoadCandidate;
  exit?: LoadCandidate;
}
interface SampleCandidate {
  error?: unknown;
  repetition?: unknown;
  state?: unknown;
  open_ms?: number;
  lexical?: { open_ms?: number; first_ms?: number; warm_ms?: number; first_paths?: unknown; warm_paths?: unknown; output_hash?: string };
  content?: { open_ms?: number; ms?: number; paths?: unknown; rows?: unknown; output_hash?: unknown };
  vectors?: { open_ms?: number; write_ms?: number; candidates_ms?: number; similar_ms?: number; pending_before?: unknown; pending_after?: unknown; candidates?: unknown; similar?: unknown; output_hash?: unknown };
  structured?: unknown;
  manifests?: { lexical?: unknown; vectors?: unknown };
  native?: NativeCandidate | null;
  vector_native?: NativeCandidate | null;
}
interface ArtifactCandidate {
  schema?: unknown;
  measure_version?: unknown;
  method_version?: unknown;
  store?: string;
  status?: unknown;
  valid?: unknown;
  errors?: unknown;
  implementation_stability?: { stable?: unknown; before?: unknown; after?: { environment?: unknown; measured_package?: unknown; harness?: unknown; native_package?: unknown; runtime?: unknown } };
  notes?: number;
  repetitions?: number;
  samples?: SampleCandidate[];
  case_id?: string;
  workload?: { inputs?: { requested?: { case_id?: unknown; vector_dims?: unknown; vector_wire_dims?: unknown; native_schema_dims?: unknown } }; fingerprint?: unknown };
  row_workload_ids?: Producer['row_workload_ids'];
  environment?: EnvironmentCandidate;
  provenance?: ProvenanceCandidate;
  readiness?: ReadinessCandidate;
  timing?: { valid?: unknown; error?: unknown; entry?: LoadCandidate; exit?: LoadCandidate };
}
type NativePackageCandidate = NonNullable<NonNullable<ProvenanceCandidate['native']>['package']>;
type ImplementationCandidate = NonNullable<NonNullable<ArtifactCandidate['implementation_stability']>['after']>;
type ValidatedCandidate = { artifact: ArtifactCandidate; checked: ReturnType<typeof validateArtifact> };
interface ErrorDetails {
  message?: unknown;
}

const STORES = ['sqlite', 'duckdb', 'turso'];
const SHA256 = /^[0-9a-f]{64}$/;
const MODEL = 'minishlab/potion-retrieval-32M';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, label: string) {
  assert(identityHash(actual) === identityHash(expected), `${label} mismatch`);
}

function exactMembers(actual: unknown, expected: readonly unknown[], label: string) {
  assert(Array.isArray(actual), `${label} is not an array`);
  assert(new Set(actual).size === actual.length, `${label} has duplicates`);
  same([...actual].sort(), [...expected].sort(), label);
}

function exactTuples(actual: unknown, expected: readonly unknown[], label: string) {
  assert(Array.isArray(actual), `${label} is not an array`);
  const sorted = (rows: readonly unknown[]) => rows.map((row) => identityHash(row)).sort();
  assert(new Set(sorted(actual)).size === actual.length, `${label} has duplicate tuples`);
  same(sorted(actual), sorted(expected), label);
}

function timing(value: unknown, label: string) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
}

function nativeObservation(value: NativeCandidate | null | undefined, store: string | undefined, label: string) {
  assert(value && typeof value === 'object', `${label} is missing`);
  assert(typeof value.version_query === 'string' && value.version_query.length > 0, `${label} version query is missing`);
  assert(typeof value.version === 'string' && value.version.length > 0 && value.version !== 'unknown', `${label} version value is missing`);
  assert(Array.isArray(value.capabilities), `${label} capabilities are missing`);
  assert(value.engine_status && typeof value.engine_status === 'object' && !Array.isArray(value.engine_status), `${label} engine status is missing`);
  const expectedQuery = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
  assert(value.version_query === expectedQuery, `${label} version query mismatch`);
}

const stableNativeObservation = ({ version_query, capabilities, version }: NativeCandidate) => ({ version_query, capabilities, version });

function provenance(artifact: ArtifactCandidate) {
  const value = artifact.provenance;
  assert(value && typeof value === 'object', 'provenance is missing');
  const measured = value.measured_package;
  assert(measured && typeof measured.name === 'string' && typeof measured.version === 'string', 'measured package identity is missing');
  assert((measured.package_json?.files as number) > 0 && SHA256.test((measured.package_json as FileIdentity).fingerprint as string), 'package.json identity is missing');
  assert(measured.dist?.status === 'recorded' && (measured.dist.files as number) > 0 && SHA256.test(measured.dist.fingerprint as string), 'built distribution identity is missing');
  assert(measured.source?.status === 'absent' || (measured.source?.status === 'recorded' && (measured.source.files as number) > 0 && SHA256.test(measured.source.fingerprint as string)), 'source identity is invalid');
  assert(value.harness?.files === NATIVE_CAPABILITY_HARNESS_FILES.length && SHA256.test((value.harness as NonNullable<ProvenanceCandidate['harness']>).fingerprint as string), 'harness identity is missing');
  same((value.harness as NonNullable<ProvenanceCandidate['harness']>).paths, [...NATIVE_CAPABILITY_HARNESS_FILES].sort(), 'harness path set');
  assert(value.runtime?.node === artifact.environment?.runtime?.node, 'runtime Node observations disagree');
  assert(value.native?.store === artifact.store, 'native store provenance mismatch');
  nativeObservation(value.native?.observation, artifact.store, 'native provenance observation');
  if (artifact.store === 'sqlite') assert((value.native as NonNullable<ProvenanceCandidate['native']>).package === null, 'sqlite must use its built-in native package identity');
  else {
    const expectedName = artifact.store === 'duckdb' ? '@duckdb/node-api' : '@tursodatabase/database';
    assert((value.native as NonNullable<ProvenanceCandidate['native']>).package?.name === expectedName, `optional native package must be ${expectedName}`);
    assert(
      typeof ((value.native as NonNullable<ProvenanceCandidate['native']>).package as NativePackageCandidate).version === 'string' &&
        (((value.native as NonNullable<ProvenanceCandidate['native']>).package as NativePackageCandidate).version as string).length > 0 &&
        ((value.native as NonNullable<ProvenanceCandidate['native']>).package as NativePackageCandidate).version !== 'unknown',
      'optional native package version is unknown'
    );
  }
  same(value.model, { status: 'configured_not_constructed', requested: MODEL, resolved_identity: 'not-observed' }, 'injected-vector model observation');
  return value;
}

function environment(artifact: ArtifactCandidate) {
  const value = artifact.environment;
  assert(value?.observation === 'runtime observation, not cryptographic attestation', 'machine observation label is missing');
  const machine = value.machine;
  assert(machine && SHA256.test(machine.hostname_sha256 as string), 'hashed hostname observation is missing');
  for (const key of ['platform', 'arch', 'release', 'cpu_model'] as const) assert(typeof machine[key] === 'string' && machine[key].length > 0 && machine[key] !== 'unknown', `machine ${key} is missing`);
  assert(Number.isInteger(machine.logical_cores) && (machine.logical_cores as number) > 0, 'machine logical cores are invalid');
  assert(Number.isFinite(machine.total_memory_bytes) && (machine.total_memory_bytes as number) > 0, 'machine memory is invalid');
  assert(value.machine_fingerprint === identityHash(machine), 'machine fingerprint does not recompute');
  assert(typeof value.runtime?.node === 'string' && value.runtime.node.length > 0, 'runtime Node version is missing');
  return value;
}

function readiness(artifact: ArtifactCandidate) {
  const value = artifact.readiness;
  assert(value && typeof value === 'object', 'readiness evidence is missing');
  const rule = readinessRule(value.policy);
  let exitAboveLimit = false;
  for (const phase of ['entry', 'exit'] as const) {
    const readinessEnvironment = value.environment?.[phase];
    assert(readinessEnvironment && typeof readinessEnvironment === 'object', `${phase} readiness environment is missing`);
    same(readinessEnvironment, artifact.environment, `${phase} readiness environment`);
    assert(!NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes((readinessEnvironment.machine as NonNullable<EnvironmentCandidate['machine']>).platform as string), `quiet-machine readiness is unsupported on ${(readinessEnvironment.machine as NonNullable<EnvironmentCandidate['machine']>).platform}`);
    const observation = value[phase];
    assert(observation && typeof observation === 'object', `${phase} readiness observation is missing`);
    for (const key of ['load1', 'load5', 'load15'] as const) timing(observation[key], `${phase} readiness ${key}`);
    if (checkReadinessReading(rule, phase, observation, (readinessEnvironment.machine as NonNullable<EnvironmentCandidate['machine']>).logical_cores as number)) exitAboveLimit = true;
    same({ load1: artifact.timing?.[phase]?.load1, load5: artifact.timing?.[phase]?.load5, load15: artifact.timing?.[phase]?.load15 }, { load1: observation.load1, load5: observation.load5, load15: observation.load15 }, `${phase} timing/readiness observation`);
  }
  assert(artifact.timing?.valid === true, 'timing is not valid');
  assert(!artifact.timing.error, 'timing carries an error');
  return { ...value, exit_above_admission_limit: exitAboveLimit };
}

function validateSample(sample: SampleCandidate | null | undefined, index: number, contract: Contract, artifact: ArtifactCandidate) {
  const label = `${artifact.store} repetition ${index + 1}`;
  assert(!sample?.error, `${label} carries an error`);
  assert(sample?.repetition === index + 1, `${label} numbering mismatch`);
  same(sample.state, { tree: 'fresh', source_cache: 'warm', index: 'cold' }, `${label} state`);
  for (const [value, name] of [
    [sample.open_ms, 'open'],
    [sample.lexical?.open_ms, 'lexical open'],
    [sample.lexical?.first_ms, 'cold lexical'],
    [sample.lexical?.warm_ms, 'warm lexical'],
    [sample.content?.open_ms, 'content open'],
    [sample.content?.ms, 'content read'],
    [sample.vectors?.open_ms, 'vector open'],
    [sample.vectors?.write_ms, 'vector write'],
    [sample.vectors?.candidates_ms, 'vector candidates'],
    [sample.vectors?.similar_ms, 'vector similar'],
  ])
    timing(value, `${label} ${name}`);
  assert(sample.open_ms === (sample.lexical as NonNullable<SampleCandidate['lexical']>).open_ms, `${label} open timing aliases disagree`);
  exactMembers((sample.lexical as NonNullable<SampleCandidate['lexical']>).first_paths, contract.expected.lexical_paths, `${label} cold lexical paths`);
  exactMembers((sample.lexical as NonNullable<SampleCandidate['lexical']>).warm_paths, contract.expected.lexical_paths, `${label} warm lexical paths`);
  assert(SHA256.test((sample.lexical as NonNullable<SampleCandidate['lexical']>).output_hash as string), `${label} discarded lexical-row hash is missing`);
  same(
    (sample.content as NonNullable<SampleCandidate['content']>).paths,
    contract.expected.content_rows.map(({ path }) => path),
    `${label} content paths`
  );
  same((sample.content as NonNullable<SampleCandidate['content']>).rows, contract.expected.content_rows, `${label} content rows`);
  assert((sample.content as NonNullable<SampleCandidate['content']>).output_hash === identityHash((sample.content as NonNullable<SampleCandidate['content']>).rows), `${label} content output hash does not recompute`);
  if (contract.expected.structured) same(sample.structured, contract.expected.structured, `${label} structured facts`);
  exactTuples((sample.vectors as NonNullable<SampleCandidate['vectors']>).pending_before, contract.expected.pending_before, `${label} pending-before tuples`);
  same((sample.vectors as NonNullable<SampleCandidate['vectors']>).pending_after, [], `${label} pending-after tuples`);
  same((sample.vectors as NonNullable<SampleCandidate['vectors']>).candidates, contract.expected.candidates, `${label} vector candidates`);
  same((sample.vectors as NonNullable<SampleCandidate['vectors']>).similar, contract.expected.similar, `${label} vector similar`);
  assert((sample.vectors as NonNullable<SampleCandidate['vectors']>).output_hash === identityHash({ candidates: (sample.vectors as NonNullable<SampleCandidate['vectors']>).candidates, similar: (sample.vectors as NonNullable<SampleCandidate['vectors']>).similar }), `${label} vector output hash does not recompute`);
  same(sample.manifests?.lexical, contract.inputs.corpus.lexical, `${label} lexical manifest`);
  same(sample.manifests?.vectors, contract.inputs.corpus.vectors, `${label} vector manifest`);
  nativeObservation(sample.native, artifact.store, `${label} lexical native observation`);
  nativeObservation(sample.vector_native, artifact.store, `${label} vector native observation`);
  same(stableNativeObservation(sample.native as NativeCandidate), stableNativeObservation(((artifact.provenance as ProvenanceCandidate).native as NonNullable<ProvenanceCandidate['native']>).observation as NativeCandidate), `${label} native provenance`);
  same(stableNativeObservation(sample.vector_native as NativeCandidate), stableNativeObservation(((artifact.provenance as ProvenanceCandidate).native as NonNullable<ProvenanceCandidate['native']>).observation as NativeCandidate), `${label} vector native provenance`);
}

function validateArtifact(artifact: ArtifactCandidate | null | undefined) {
  assert(artifact && typeof artifact === 'object', 'artifact is not an object');
  assert(artifact.schema === NATIVE_CAPABILITY_SCHEMA, `unsupported schema ${artifact.schema ?? 'missing'}`);
  assert(artifact.measure_version === MEASURE_VERSION, `${artifact.store ?? 'unknown'} measure_version ${artifact.measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
  assert(artifact.method_version === NATIVE_CAPABILITY_METHOD_VERSION, `${artifact.store ?? 'unknown'} method_version ${artifact.method_version ?? 'missing'} does not match current ${NATIVE_CAPABILITY_METHOD_VERSION}`);
  assert(STORES.includes(artifact.store as string), `unknown store ${artifact.store ?? 'missing'}`);
  assert(artifact.status === 'success', `${artifact.store} artifact status is not successful`);
  assert(artifact.valid === true && Array.isArray(artifact.errors) && artifact.errors.length === 0, `${artifact.store} correctness is invalid`);
  assert(artifact.implementation_stability?.stable === true, `${artifact.store} implementation identity was not stable`);
  assert(identityHash(artifact.implementation_stability.before) === identityHash(artifact.implementation_stability.after), `${artifact.store} implementation stability evidence disagrees`);
  assert(identityHash((artifact.implementation_stability.after as ImplementationCandidate).environment) === identityHash(artifact.environment), `${artifact.store} final environment evidence disagrees`);
  assert(identityHash((artifact.implementation_stability.after as ImplementationCandidate).measured_package) === identityHash(artifact.provenance?.measured_package), `${artifact.store} final package evidence disagrees`);
  assert(identityHash((artifact.implementation_stability.after as ImplementationCandidate).harness) === identityHash(artifact.provenance?.harness), `${artifact.store} final harness evidence disagrees`);
  assert(identityHash((artifact.implementation_stability.after as ImplementationCandidate).native_package) === identityHash(artifact.provenance?.native?.package), `${artifact.store} final native package evidence disagrees`);
  assert(identityHash((artifact.implementation_stability.after as ImplementationCandidate).runtime) === identityHash(artifact.provenance?.runtime), `${artifact.store} final runtime evidence disagrees`);
  assert(Number.isInteger(artifact.notes) && (artifact.notes as number) >= 4 && (artifact.notes as number) <= MAX_NATIVE_NOTES, `${artifact.store} note count is invalid`);
  assert(Number.isInteger(artifact.repetitions) && (artifact.repetitions as number) >= 3 && (artifact.repetitions as number) <= MAX_NATIVE_REPETITIONS, `${artifact.store} repetition count is invalid`);
  assert(Array.isArray(artifact.samples) && artifact.samples.length === artifact.repetitions, `${artifact.store} samples do not match repetitions`);
  const requested = artifact.workload?.inputs?.requested;
  assert(requested?.case_id === artifact.case_id, `${artifact.store} case identity is missing or inconsistent`);
  assert(requested?.vector_dims === requested?.vector_wire_dims, `${artifact.store} vector dimensions are unsupported`);
  assert(requested?.native_schema_dims === NATIVE_CAPABILITY_VECTOR_DIMS, `${artifact.store} native schema dimensions are unsupported`);
  const contract = nativeCapabilityContract({ caseId: artifact.case_id, notes: artifact.notes, repetitions: artifact.repetitions });
  same(artifact.workload?.inputs, contract.inputs, `${artifact.store} workload inputs`);
  assert(artifact.workload?.fingerprint === contract.fingerprint, `${artifact.store} workload fingerprint does not recompute`);
  same(Object.keys(artifact.row_workload_ids ?? {}).sort(), [...NATIVE_CAPABILITY_ROWS].sort(), `${artifact.store} row workload keys`);
  same(artifact.row_workload_ids, contract.row_workload_ids, `${artifact.store} row workload identities`);
  const env = environment(artifact);
  const prov = provenance(artifact);
  const ready = readiness(artifact);
  artifact.samples.forEach((sample, index) => validateSample(sample, index, contract, artifact));
  return { contract, environment: env, provenance: prov, readiness: ready };
}

function rowTiming(sample: SampleCandidate, row: string): number {
  if (row === 'open') return sample.open_ms as number;
  if (row === 'cold_lexical') return (sample.lexical as NonNullable<SampleCandidate['lexical']>).first_ms as number;
  if (row === 'warm_lexical') return (sample.lexical as NonNullable<SampleCandidate['lexical']>).warm_ms as number;
  if (row === 'content_read') return (sample.content as NonNullable<SampleCandidate['content']>).ms as number;
  if (row === 'vector_write') return (sample.vectors as NonNullable<SampleCandidate['vectors']>).write_ms as number;
  if (row === 'vector_candidates') return (sample.vectors as NonNullable<SampleCandidate['vectors']>).candidates_ms as number;
  return (sample.vectors as NonNullable<SampleCandidate['vectors']>).similar_ms as number;
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function compareNativeCapabilityArtifacts(artifacts: unknown) {
  const reasons: string[] = [];
  const validated: ValidatedCandidate[] = [];
  if (!Array.isArray(artifacts)) reasons.push('artifacts must be an array');
  else {
    for (const [index, artifact] of artifacts.entries()) {
      try {
        validated.push({ artifact, checked: validateArtifact(artifact) });
      } catch (error) {
        reasons.push(`artifact ${index + 1}: ${(error as ErrorDetails | null | undefined)?.message ?? error}`);
      }
    }
  }
  if (reasons.length === 0) {
    const stores = validated.map(({ artifact }) => artifact.store);
    if (new Set(stores).size !== stores.length) reasons.push('store set has duplicates');
    if (identityHash([...stores].sort()) !== identityHash([...STORES].sort())) reasons.push(`store set must be ${STORES.join(', ')}`);
    const first = validated[0];
    for (const current of validated.slice(1)) {
      for (const [label, select] of [
        ['workload inputs', (item: ValidatedCandidate) => item.artifact.workload],
        ['row workload identities', (item: ValidatedCandidate) => item.artifact.row_workload_ids],
        ['machine identity', (item: ValidatedCandidate) => item.checked.environment],
        ['runtime Node version', (item: ValidatedCandidate) => item.checked.environment.runtime],
        ['readiness policy', (item: ValidatedCandidate) => item.checked.readiness.policy],
        ['measured package identity', (item: ValidatedCandidate) => item.checked.provenance.measured_package],
        ['harness identity', (item: ValidatedCandidate) => item.checked.provenance.harness],
      ] as const) {
        if (identityHash(select(current)) !== identityHash(select(first))) reasons.push(`${label} differs between ${first.artifact.store} and ${current.artifact.store}`);
      }
    }
  }
  // Stores whose exit reading was above the admission limit: their timings are observations, not clean
  // comparisons. Absent when there are none, so comparisons recorded before the policy change recompute.
  const exitAbove = reasons.length === 0 ? validated.filter(({ checked }) => checked.readiness.exit_above_admission_limit).map(({ artifact }) => artifact.store as string) : [];
  return {
    schema: 'native-capability-comparison-v1',
    eligible: reasons.length === 0,
    reasons,
    ...(exitAbove.length > 0 ? { exit_load_above_admission_limit: exitAbove } : {}),
    stores: Array.isArray(artifacts) ? artifacts.map((artifact: { store?: unknown } | null | undefined) => artifact?.store ?? null) : [],
    common_rows:
      reasons.length === 0
        ? Object.fromEntries(
            NATIVE_CAPABILITY_ROWS.map((row) => {
              const samples = Object.fromEntries(validated.map(({ artifact }) => [artifact.store as string, (artifact.samples as SampleCandidate[]).map((sample) => rowTiming(sample, row))] as const));
              return [
                row,
                {
                  workload_id: (validated[0].artifact.row_workload_ids as NonNullable<ArtifactCandidate['row_workload_ids']>)[row],
                  eligible: true,
                  samples_ms_by_store: samples,
                  median_ms_by_store: Object.fromEntries(Object.entries(samples).map(([store, values]) => [store, median(values)])),
                  ...(row === 'content_read' ? { scope: 'fixed-path native SQL content read; not production search hydration' } : {}),
                  ...(row === 'cold_lexical' || row === 'warm_lexical' ? { lexical_row_hash_recomputed: false } : {}),
                },
              ];
            })
          )
        : {},
  };
}
