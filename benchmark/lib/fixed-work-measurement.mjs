import { loadavg } from 'node:os';
import { NATIVE_CAPABILITY_READINESS_POLICY, nativeCapabilityEnvironment } from './native-capability.mjs';
import { quietMachineCheck } from './quiet-machine.mjs';
import { identityHash, implementationProvenance } from './workload-identity.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export function readinessObservation(environment = nativeCapabilityEnvironment(), load = loadavg()) {
  const supported = !NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(environment.machine.platform);
  const passed = supported && !quietMachineCheck(load[0], environment.machine.logical_cores).blocked;
  return { environment, load: { load1: load[0], load5: load[1], load15: load[2] }, supported, passed };
}

export function fixedWorkProvenance({ packageRoot, harnessFiles, store = 'sqlite', nativeObservation = { status: 'not-applicable' } }) {
  return implementationProvenance({
    packageRoot,
    harnessRoot: packageRoot,
    harnessFiles,
    store,
    nativeObservation,
    modelObservation: { status: 'not-applicable' },
  });
}

export const stableFixedWorkIdentity = (provenance, environment) => ({
  measured_package: provenance.measured_package,
  harness: provenance.harness,
  runtime: provenance.runtime,
  native_package: provenance.native.package,
  environment,
});

export function fixedWorkReadiness(entry, exit) {
  return {
    policy: { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) },
    environment: { entry: entry.environment, exit: exit?.environment ?? null },
    entry: { ...entry.load, supported: entry.supported, passed: entry.passed },
    exit: exit ? { ...exit.load, supported: exit.supported, passed: exit.passed } : null,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, label) {
  assert(identityHash(actual) === identityHash(expected), `${label} mismatch`);
}

export function validateFixedWorkArtifact(artifact, { schema, repetitions, harnessFiles, store = null }) {
  assert(artifact?.schema === schema, `unsupported schema ${artifact?.schema ?? 'missing'}`);
  assert(artifact.status === 'success' && artifact.valid === true, `artifact is not successful: ${artifact?.errors?.join('; ') ?? artifact?.status ?? 'invalid'}`);
  assert(artifact.repetitions === repetitions && artifact.samples?.length === repetitions, 'repetition coverage mismatch');
  assert(typeof artifact.workload?.fingerprint === 'string' && SHA256.test(artifact.workload.fingerprint), 'workload fingerprint is invalid');
  assert(artifact.workload.fingerprint === identityHash(artifact.workload.inputs), 'workload fingerprint does not recompute');
  for (const [index, sample] of artifact.samples.entries()) {
    assert(sample.repetition === index + 1, `repetition ${index + 1} numbering mismatch`);
    assert(!sample.error, `repetition ${index + 1} carries an error`);
    assert(typeof sample.ms === 'number' && Number.isFinite(sample.ms) && sample.ms >= 0, `repetition ${index + 1} timing is invalid`);
  }
  const readiness = artifact.readiness;
  same(readiness?.policy, { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) }, 'readiness policy');
  for (const phase of ['entry', 'exit']) {
    const environment = readiness?.environment?.[phase];
    const observation = readiness?.[phase];
    assert(environment && observation, `${phase} readiness evidence is missing`);
    assert(environment.machine_fingerprint === identityHash(environment.machine), `${phase} machine fingerprint does not recompute`);
    assert(typeof environment.runtime?.node === 'string' && environment.runtime.node.length > 0, `${phase} Node runtime is missing`);
    assert(!NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(environment.machine.platform), `${phase} readiness is unsupported`);
    assert(environment.machine.logical_cores > 0, `${phase} core count is invalid`);
    for (const key of ['load1', 'load5', 'load15']) assert(typeof observation[key] === 'number' && Number.isFinite(observation[key]) && observation[key] >= 0, `${phase} ${key} is invalid`);
    const expected = !quietMachineCheck(observation.load1, environment.machine.logical_cores).blocked;
    assert(observation.supported === true && observation.passed === expected && expected, `${phase} readiness did not pass`);
  }
  const provenance = artifact.provenance;
  assert(provenance?.harness?.files === harnessFiles.length && SHA256.test(provenance.harness.fingerprint), 'harness identity is missing');
  same(provenance.harness.paths, [...harnessFiles].sort(), 'harness paths');
  assert(provenance.measured_package?.dist?.status === 'recorded' && SHA256.test(provenance.measured_package.dist.fingerprint), 'dist identity is missing');
  assert(provenance.runtime?.node === artifact.environment?.runtime?.node, 'runtime provenance mismatch');
  if (store !== null) {
    assert(provenance.native?.store === store && artifact.store === store, 'store provenance mismatch');
    const native = provenance.native.observation;
    const query = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
    assert(native?.version_query === query && typeof native.version === 'string' && native.version.length > 0, 'native version observation is missing');
    assert(Array.isArray(native.capabilities), 'native capability observation is missing');
    if (store !== 'sqlite') assert(typeof provenance.native.package?.version === 'string' && provenance.native.package.version !== 'unknown', 'native package version is missing');
  }
  assert(artifact.implementation_stability?.stable === true, 'implementation identity was not stable');
  same(artifact.implementation_stability.before, artifact.implementation_stability.after, 'implementation stability');
  assert(typeof artifact.median_ms === 'number' && Number.isFinite(artifact.median_ms) && artifact.median_ms >= 0, 'median timing is invalid');
  const ordered = artifact.samples.map(({ ms }) => ms).sort((a, b) => a - b);
  assert(artifact.median_ms === ordered[Math.floor(ordered.length / 2)], 'median timing does not recompute');
  return artifact;
}
