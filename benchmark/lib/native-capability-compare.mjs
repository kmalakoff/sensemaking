// Fail-closed comparison preflight for the standalone native-capability diagnostic. This does
// not classify performance, change a gate, or equate fixed-path SQL reads with search hydration.

import { MEASURE_VERSION } from './measure.mjs';
import { MAX_NATIVE_NOTES, MAX_NATIVE_REPETITIONS, NATIVE_CAPABILITY_HARNESS_FILES, NATIVE_CAPABILITY_READINESS_POLICY, NATIVE_CAPABILITY_ROWS, NATIVE_CAPABILITY_SCHEMA, NATIVE_CAPABILITY_VECTOR_DIMS, nativeCapabilityContract } from './native-capability.mjs';
import { quietMachineCheck } from './quiet-machine.mjs';
import { identityHash } from './workload-identity.mjs';

const STORES = ['sqlite', 'duckdb', 'turso'];
const SHA256 = /^[0-9a-f]{64}$/;
const MODEL = 'minishlab/potion-retrieval-32M';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function same(actual, expected, label) {
  assert(identityHash(actual) === identityHash(expected), `${label} mismatch`);
}

function exactMembers(actual, expected, label) {
  assert(Array.isArray(actual), `${label} is not an array`);
  assert(new Set(actual).size === actual.length, `${label} has duplicates`);
  same([...actual].sort(), [...expected].sort(), label);
}

function exactTuples(actual, expected, label) {
  assert(Array.isArray(actual), `${label} is not an array`);
  const sorted = (rows) => rows.map((row) => identityHash(row)).sort();
  assert(new Set(sorted(actual)).size === actual.length, `${label} has duplicate tuples`);
  same(sorted(actual), sorted(expected), label);
}

function timing(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${label} must be finite and nonnegative`);
}

function nativeObservation(value, store, label) {
  assert(value && typeof value === 'object', `${label} is missing`);
  assert(typeof value.version_query === 'string' && value.version_query.length > 0, `${label} version query is missing`);
  assert(typeof value.version === 'string' && value.version.length > 0 && value.version !== 'unknown', `${label} version value is missing`);
  assert(Array.isArray(value.capabilities), `${label} capabilities are missing`);
  assert(value.engine_status && typeof value.engine_status === 'object' && !Array.isArray(value.engine_status), `${label} engine status is missing`);
  const expectedQuery = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
  assert(value.version_query === expectedQuery, `${label} version query mismatch`);
}

const stableNativeObservation = ({ version_query, capabilities, version }) => ({ version_query, capabilities, version });

function provenance(artifact) {
  const value = artifact.provenance;
  assert(value && typeof value === 'object', 'provenance is missing');
  const measured = value.measured_package;
  assert(measured && typeof measured.name === 'string' && typeof measured.version === 'string', 'measured package identity is missing');
  assert(measured.package_json?.files > 0 && SHA256.test(measured.package_json.fingerprint), 'package.json identity is missing');
  assert(measured.dist?.status === 'recorded' && measured.dist.files > 0 && SHA256.test(measured.dist.fingerprint), 'built distribution identity is missing');
  assert(measured.source?.status === 'absent' || (measured.source?.status === 'recorded' && measured.source.files > 0 && SHA256.test(measured.source.fingerprint)), 'source identity is invalid');
  assert(value.harness?.files === NATIVE_CAPABILITY_HARNESS_FILES.length && SHA256.test(value.harness.fingerprint), 'harness identity is missing');
  same(value.harness.paths, [...NATIVE_CAPABILITY_HARNESS_FILES].sort(), 'harness path set');
  assert(value.runtime?.node === artifact.environment?.runtime?.node, 'runtime Node observations disagree');
  assert(value.native?.store === artifact.store, 'native store provenance mismatch');
  nativeObservation(value.native?.observation, artifact.store, 'native provenance observation');
  if (artifact.store === 'sqlite') assert(value.native.package === null, 'sqlite must use its built-in native package identity');
  else {
    const expectedName = artifact.store === 'duckdb' ? '@duckdb/node-api' : '@tursodatabase/database';
    assert(value.native.package?.name === expectedName, `optional native package must be ${expectedName}`);
    assert(typeof value.native.package.version === 'string' && value.native.package.version.length > 0 && value.native.package.version !== 'unknown', 'optional native package version is unknown');
  }
  same(value.model, { status: 'configured_not_constructed', requested: MODEL, resolved_identity: 'not-observed' }, 'injected-vector model observation');
  return value;
}

function environment(artifact) {
  const value = artifact.environment;
  assert(value?.observation === 'runtime observation, not cryptographic attestation', 'machine observation label is missing');
  const machine = value.machine;
  assert(machine && SHA256.test(machine.hostname_sha256), 'hashed hostname observation is missing');
  for (const key of ['platform', 'arch', 'release', 'cpu_model']) assert(typeof machine[key] === 'string' && machine[key].length > 0 && machine[key] !== 'unknown', `machine ${key} is missing`);
  assert(Number.isInteger(machine.logical_cores) && machine.logical_cores > 0, 'machine logical cores are invalid');
  assert(Number.isFinite(machine.total_memory_bytes) && machine.total_memory_bytes > 0, 'machine memory is invalid');
  assert(value.machine_fingerprint === identityHash(machine), 'machine fingerprint does not recompute');
  assert(typeof value.runtime?.node === 'string' && value.runtime.node.length > 0, 'runtime Node version is missing');
  return value;
}

function readiness(artifact) {
  const value = artifact.readiness;
  assert(value && typeof value === 'object', 'readiness evidence is missing');
  const expectedPolicy = { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) };
  same(value.policy, expectedPolicy, 'readiness policy');
  for (const phase of ['entry', 'exit']) {
    const readinessEnvironment = value.environment?.[phase];
    assert(readinessEnvironment && typeof readinessEnvironment === 'object', `${phase} readiness environment is missing`);
    same(readinessEnvironment, artifact.environment, `${phase} readiness environment`);
    assert(!NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(readinessEnvironment.machine.platform), `quiet-machine readiness is unsupported on ${readinessEnvironment.machine.platform}`);
    const observation = value[phase];
    assert(observation && typeof observation === 'object', `${phase} readiness observation is missing`);
    for (const key of ['load1', 'load5', 'load15']) timing(observation[key], `${phase} readiness ${key}`);
    const expectedPass = !quietMachineCheck(observation.load1, readinessEnvironment.machine.logical_cores).blocked;
    assert(observation.supported === true, `${phase} readiness is unsupported`);
    assert(observation.passed === expectedPass, `${phase} readiness pass contradicts load and core count`);
    assert(observation.passed === true, `${phase} readiness did not pass`);
    same({ load1: artifact.timing?.[phase]?.load1, load5: artifact.timing?.[phase]?.load5, load15: artifact.timing?.[phase]?.load15 }, { load1: observation.load1, load5: observation.load5, load15: observation.load15 }, `${phase} timing/readiness observation`);
  }
  assert(artifact.timing?.valid === true, 'timing is not valid');
  assert(!artifact.timing.error, 'timing carries an error');
  return value;
}

function validateSample(sample, index, contract, artifact) {
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
  assert(sample.open_ms === sample.lexical.open_ms, `${label} open timing aliases disagree`);
  exactMembers(sample.lexical.first_paths, contract.expected.lexical_paths, `${label} cold lexical paths`);
  exactMembers(sample.lexical.warm_paths, contract.expected.lexical_paths, `${label} warm lexical paths`);
  assert(SHA256.test(sample.lexical.output_hash), `${label} discarded lexical-row hash is missing`);
  same(
    sample.content.paths,
    contract.expected.content_rows.map(({ path }) => path),
    `${label} content paths`
  );
  same(sample.content.rows, contract.expected.content_rows, `${label} content rows`);
  assert(sample.content.output_hash === identityHash(sample.content.rows), `${label} content output hash does not recompute`);
  if (contract.expected.structured) same(sample.structured, contract.expected.structured, `${label} structured facts`);
  exactTuples(sample.vectors.pending_before, contract.expected.pending_before, `${label} pending-before tuples`);
  same(sample.vectors.pending_after, [], `${label} pending-after tuples`);
  same(sample.vectors.candidates, contract.expected.candidates, `${label} vector candidates`);
  same(sample.vectors.similar, contract.expected.similar, `${label} vector similar`);
  assert(sample.vectors.output_hash === identityHash({ candidates: sample.vectors.candidates, similar: sample.vectors.similar }), `${label} vector output hash does not recompute`);
  same(sample.manifests?.lexical, contract.inputs.corpus.lexical, `${label} lexical manifest`);
  same(sample.manifests?.vectors, contract.inputs.corpus.vectors, `${label} vector manifest`);
  nativeObservation(sample.native, artifact.store, `${label} lexical native observation`);
  nativeObservation(sample.vector_native, artifact.store, `${label} vector native observation`);
  same(stableNativeObservation(sample.native), stableNativeObservation(artifact.provenance.native.observation), `${label} native provenance`);
  same(stableNativeObservation(sample.vector_native), stableNativeObservation(artifact.provenance.native.observation), `${label} vector native provenance`);
}

function validateArtifact(artifact) {
  assert(artifact && typeof artifact === 'object', 'artifact is not an object');
  assert(artifact.schema === NATIVE_CAPABILITY_SCHEMA, `unsupported schema ${artifact.schema ?? 'missing'}`);
  assert(artifact.measure_version === MEASURE_VERSION, `${artifact.store ?? 'unknown'} measure_version ${artifact.measure_version ?? 'missing'} does not match current ${MEASURE_VERSION}`);
  assert(STORES.includes(artifact.store), `unknown store ${artifact.store ?? 'missing'}`);
  assert(artifact.status === 'success', `${artifact.store} artifact status is not successful`);
  assert(artifact.valid === true && Array.isArray(artifact.errors) && artifact.errors.length === 0, `${artifact.store} correctness is invalid`);
  assert(artifact.implementation_stability?.stable === true, `${artifact.store} implementation identity was not stable`);
  assert(identityHash(artifact.implementation_stability.before) === identityHash(artifact.implementation_stability.after), `${artifact.store} implementation stability evidence disagrees`);
  assert(identityHash(artifact.implementation_stability.after.environment) === identityHash(artifact.environment), `${artifact.store} final environment evidence disagrees`);
  assert(identityHash(artifact.implementation_stability.after.measured_package) === identityHash(artifact.provenance?.measured_package), `${artifact.store} final package evidence disagrees`);
  assert(identityHash(artifact.implementation_stability.after.harness) === identityHash(artifact.provenance?.harness), `${artifact.store} final harness evidence disagrees`);
  assert(identityHash(artifact.implementation_stability.after.native_package) === identityHash(artifact.provenance?.native?.package), `${artifact.store} final native package evidence disagrees`);
  assert(identityHash(artifact.implementation_stability.after.runtime) === identityHash(artifact.provenance?.runtime), `${artifact.store} final runtime evidence disagrees`);
  assert(Number.isInteger(artifact.notes) && artifact.notes >= 4 && artifact.notes <= MAX_NATIVE_NOTES, `${artifact.store} note count is invalid`);
  assert(Number.isInteger(artifact.repetitions) && artifact.repetitions >= 3 && artifact.repetitions <= MAX_NATIVE_REPETITIONS, `${artifact.store} repetition count is invalid`);
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

function rowTiming(sample, row) {
  if (row === 'open') return sample.open_ms;
  if (row === 'cold_lexical') return sample.lexical.first_ms;
  if (row === 'warm_lexical') return sample.lexical.warm_ms;
  if (row === 'content_read') return sample.content.ms;
  if (row === 'vector_write') return sample.vectors.write_ms;
  if (row === 'vector_candidates') return sample.vectors.candidates_ms;
  return sample.vectors.similar_ms;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function compareNativeCapabilityArtifacts(artifacts) {
  const reasons = [];
  const validated = [];
  if (!Array.isArray(artifacts)) reasons.push('artifacts must be an array');
  else {
    for (const [index, artifact] of artifacts.entries()) {
      try {
        validated.push({ artifact, checked: validateArtifact(artifact) });
      } catch (error) {
        reasons.push(`artifact ${index + 1}: ${error?.message ?? error}`);
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
        ['workload inputs', (item) => item.artifact.workload],
        ['row workload identities', (item) => item.artifact.row_workload_ids],
        ['machine identity', (item) => item.checked.environment],
        ['runtime Node version', (item) => item.checked.environment.runtime],
        ['readiness policy', (item) => item.checked.readiness.policy],
        ['measured package identity', (item) => item.checked.provenance.measured_package],
        ['harness identity', (item) => item.checked.provenance.harness],
      ]) {
        if (identityHash(select(current)) !== identityHash(select(first))) reasons.push(`${label} differs between ${first.artifact.store} and ${current.artifact.store}`);
      }
    }
  }
  return {
    schema: 'native-capability-comparison-v1',
    eligible: reasons.length === 0,
    reasons,
    stores: Array.isArray(artifacts) ? artifacts.map((artifact) => artifact?.store ?? null) : [],
    common_rows:
      reasons.length === 0
        ? Object.fromEntries(
            NATIVE_CAPABILITY_ROWS.map((row) => {
              const samples = Object.fromEntries(validated.map(({ artifact }) => [artifact.store, artifact.samples.map((sample) => rowTiming(sample, row))]));
              return [
                row,
                {
                  workload_id: validated[0].artifact.row_workload_ids[row],
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
