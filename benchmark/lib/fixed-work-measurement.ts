import { loadavg } from 'node:os';
import { checkReadinessReading, NATIVE_CAPABILITY_READINESS_POLICY, nativeCapabilityEnvironment, readinessRule } from './native-capability.ts';
import { quietMachineCheck } from './quiet-machine.ts';
import { identityHash, implementationProvenance } from './workload-identity.ts';

type Environment = ReturnType<typeof nativeCapabilityEnvironment>;
interface ConsumerEnvironment {
  machine: Pick<Environment['machine'], 'logical_cores'> & { platform: string };
  machine_fingerprint: Environment['machine_fingerprint'];
  runtime: Environment['runtime'];
}
type ReadinessObservation = ReturnType<typeof readinessObservation>;
type Provenance = ReturnType<typeof implementationProvenance>;
interface ReadinessLoad {
  load1?: unknown;
  load5?: unknown;
  load15?: unknown;
  supported?: unknown;
  passed?: unknown;
  above_admission_limit?: unknown;
}
export interface FixedWorkArtifactInput {
  schema?: unknown;
  status?: unknown;
  valid?: unknown;
  errors?: string[];
  repetitions?: unknown;
  samples?: { repetition?: unknown; error?: unknown; ms?: unknown }[];
  workload?: { fingerprint?: unknown; inputs?: unknown };
  readiness?: { policy?: unknown; environment?: { entry?: ConsumerEnvironment | null; exit?: ConsumerEnvironment | null }; entry?: ReadinessLoad | null; exit?: ReadinessLoad | null };
  provenance?: {
    harness?: { files?: unknown; fingerprint?: string; paths?: unknown };
    measured_package?: { dist?: { status?: unknown; fingerprint?: string } };
    runtime?: { node?: unknown };
    native?: { store?: unknown; observation?: unknown; package?: { version?: unknown } | null };
  };
  environment?: ConsumerEnvironment;
  store?: unknown;
  implementation_stability?: { stable?: unknown; before?: unknown; after?: unknown };
  median_ms?: unknown;
}

const SHA256 = /^[0-9a-f]{64}$/;

export function readinessObservation(environment = nativeCapabilityEnvironment(), load = loadavg()) {
  const supported = !NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(environment.machine.platform);
  const passed = supported && !quietMachineCheck(load[0], environment.machine.logical_cores).blocked;
  return { environment, load: { load1: load[0], load5: load[1], load15: load[2] }, supported, passed };
}

export function fixedWorkProvenance({ packageRoot, harnessFiles, store = 'sqlite', nativeObservation = { status: 'not-applicable' } }: { packageRoot: string; harnessFiles: readonly string[]; store?: string; nativeObservation?: unknown }) {
  return implementationProvenance({
    packageRoot,
    harnessRoot: packageRoot,
    harnessFiles,
    store,
    nativeObservation,
    modelObservation: { status: 'not-applicable' },
  });
}

export const stableFixedWorkIdentity = <E>(provenance: Pick<Provenance, 'measured_package' | 'harness' | 'runtime' | 'native'>, environment: E) => ({
  measured_package: provenance.measured_package,
  harness: provenance.harness,
  runtime: provenance.runtime,
  native_package: provenance.native.package,
  environment,
});

export function fixedWorkReadiness(entry: ReadinessObservation, exit: ReadinessObservation | null) {
  return {
    policy: { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) },
    environment: { entry: entry.environment, exit: exit?.environment ?? null },
    entry: { ...entry.load, supported: entry.supported, passed: entry.passed },
    // recorded, not gated: see NATIVE_CAPABILITY_READINESS_POLICY
    exit: exit ? { ...exit.load, supported: exit.supported, above_admission_limit: exit.supported && !exit.passed } : null,
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Whether an artifact's exit reading was above the admission limit: its timing is then an observation,
// not a clean comparison. Historical artifacts were valid only when their exit passed, and an artifact
// under any other policy is reported by validateFixedWorkArtifact, not here.
export function exitAboveAdmissionLimit(artifact: unknown): boolean {
  const readiness = (artifact as FixedWorkArtifactInput | null | undefined)?.readiness;
  const policy = readiness?.policy as { fingerprint?: unknown } | undefined;
  if (policy?.fingerprint !== identityHash(NATIVE_CAPABILITY_READINESS_POLICY)) return false;
  return readinessRule(policy) === 'current' && readiness?.exit?.above_admission_limit === true;
}

function same(actual: unknown, expected: unknown, label: string) {
  assert(identityHash(actual) === identityHash(expected), `${label} mismatch`);
}

export function validateFixedWorkArtifact(artifact: unknown, { schema, repetitions, harnessFiles, store = null }: { schema: string; repetitions: number; harnessFiles: readonly string[]; store?: string | null }) {
  assert((artifact as { schema?: FixedWorkArtifactInput['schema'] } | null | undefined)?.schema === schema, `unsupported schema ${(artifact as { schema?: FixedWorkArtifactInput['schema'] } | null | undefined)?.schema ?? 'missing'}`);
  assert(
    (artifact as { status: FixedWorkArtifactInput['status'] }).status === 'success' && (artifact as { valid: FixedWorkArtifactInput['valid'] }).valid === true,
    `artifact is not successful: ${(artifact as { errors?: FixedWorkArtifactInput['errors'] } | null | undefined)?.errors?.join('; ') ?? (artifact as { status?: FixedWorkArtifactInput['status'] } | null | undefined)?.status ?? 'invalid'}`
  );
  assert((artifact as { repetitions: FixedWorkArtifactInput['repetitions'] }).repetitions === repetitions && (artifact as { samples: NonNullable<FixedWorkArtifactInput['samples']> }).samples?.length === repetitions, 'repetition coverage mismatch');
  assert(typeof (artifact as { workload: NonNullable<FixedWorkArtifactInput['workload']> }).workload?.fingerprint === 'string' && SHA256.test((artifact as { workload: NonNullable<FixedWorkArtifactInput['workload']> }).workload.fingerprint as string), 'workload fingerprint is invalid');
  assert((artifact as { workload: NonNullable<FixedWorkArtifactInput['workload']> }).workload.fingerprint === identityHash((artifact as { workload: NonNullable<FixedWorkArtifactInput['workload']> }).workload.inputs), 'workload fingerprint does not recompute');
  for (const [index, sample] of (artifact as { samples: NonNullable<FixedWorkArtifactInput['samples']> }).samples.entries()) {
    assert(sample.repetition === index + 1, `repetition ${index + 1} numbering mismatch`);
    assert(!sample.error, `repetition ${index + 1} carries an error`);
    assert(typeof sample.ms === 'number' && Number.isFinite(sample.ms) && sample.ms >= 0, `repetition ${index + 1} timing is invalid`);
  }
  const readiness = (artifact as { readiness: NonNullable<FixedWorkArtifactInput['readiness']> }).readiness;
  const rule = readinessRule(readiness?.policy);
  for (const phase of ['entry', 'exit'] as const) {
    const environment = readiness?.environment?.[phase];
    const observation = readiness?.[phase];
    assert(environment && observation, `${phase} readiness evidence is missing`);
    assert(environment.machine_fingerprint === identityHash(environment.machine), `${phase} machine fingerprint does not recompute`);
    assert(typeof environment.runtime?.node === 'string' && environment.runtime.node.length > 0, `${phase} Node runtime is missing`);
    assert(!NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(environment.machine.platform), `${phase} readiness is unsupported`);
    assert(environment.machine.logical_cores > 0, `${phase} core count is invalid`);
    for (const key of ['load1', 'load5', 'load15'] as const) assert(typeof observation[key] === 'number' && Number.isFinite(observation[key]) && observation[key] >= 0, `${phase} ${key} is invalid`);
    checkReadinessReading(rule, phase, observation, environment.machine.logical_cores);
  }
  const provenance = (artifact as { provenance: NonNullable<FixedWorkArtifactInput['provenance']> }).provenance;
  assert(provenance?.harness?.files === harnessFiles.length && SHA256.test(provenance.harness.fingerprint as string), 'harness identity is missing');
  same(provenance.harness.paths, [...harnessFiles].sort(), 'harness paths');
  assert(provenance.measured_package?.dist?.status === 'recorded' && SHA256.test(provenance.measured_package.dist.fingerprint as string), 'dist identity is missing');
  assert(provenance.runtime?.node === (artifact as { environment: NonNullable<FixedWorkArtifactInput['environment']> }).environment?.runtime?.node, 'runtime provenance mismatch');
  if (store !== null) {
    assert(provenance.native?.store === store && (artifact as { store: FixedWorkArtifactInput['store'] }).store === store, 'store provenance mismatch');
    const native = provenance.native.observation as { version_query?: unknown; version?: unknown; capabilities?: unknown } | null | undefined;
    const query = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
    assert(native?.version_query === query && typeof native.version === 'string' && native.version.length > 0, 'native version observation is missing');
    assert(Array.isArray(native.capabilities), 'native capability observation is missing');
    if (store !== 'sqlite') assert(typeof provenance.native.package?.version === 'string' && provenance.native.package.version !== 'unknown', 'native package version is missing');
  }
  assert((artifact as { implementation_stability: NonNullable<FixedWorkArtifactInput['implementation_stability']> }).implementation_stability?.stable === true, 'implementation identity was not stable');
  same((artifact as { implementation_stability: NonNullable<FixedWorkArtifactInput['implementation_stability']> }).implementation_stability.before, (artifact as { implementation_stability: NonNullable<FixedWorkArtifactInput['implementation_stability']> }).implementation_stability.after, 'implementation stability');
  assert(
    typeof (artifact as { median_ms: FixedWorkArtifactInput['median_ms'] }).median_ms === 'number' && Number.isFinite((artifact as { median_ms: FixedWorkArtifactInput['median_ms'] }).median_ms) && ((artifact as { median_ms: FixedWorkArtifactInput['median_ms'] }).median_ms as number) >= 0,
    'median timing is invalid'
  );
  const ordered = (artifact as { samples: NonNullable<FixedWorkArtifactInput['samples']> }).samples.map(({ ms }) => ms as number).sort((a, b) => a - b);
  assert((artifact as { median_ms: FixedWorkArtifactInput['median_ms'] }).median_ms === ordered[Math.floor(ordered.length / 2)], 'median timing does not recompute');
  return artifact;
}
