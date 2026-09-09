import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { open, STORE_NAMES } from 'sensemaking';
import { NATIVE_CAPABILITY_READINESS_POLICY, nativeCapabilityEnvironment, runNativeCapability } from '../../benchmark/lib/native-capability.mjs';
import { compareNativeCapabilityArtifacts } from '../../benchmark/lib/native-capability-compare.mjs';
import { quietMachineCheck } from '../../benchmark/lib/quiet-machine.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { STORE_DIMS } from '../../src/embed/types.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

const policy = { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) };
type NativeArtifact = Awaited<ReturnType<typeof runNativeCapability>>;
type LoadObservation = { load1: number; load5: number; load15: number };
type ReadinessPolicyEvidence = { method: string; max_load_per_logical_core: number; unsupported_platforms: string[]; fingerprint: string };
type ComparisonArtifact = NativeArtifact & {
  readiness: {
    policy: ReadinessPolicyEvidence;
    environment: { entry: NativeArtifact['environment']; exit: NativeArtifact['environment'] };
    entry: LoadObservation & { supported: boolean; passed: boolean };
    exit: LoadObservation & { supported: boolean; passed: boolean };
  };
  timing: { valid: boolean; entry: LoadObservation; exit: LoadObservation; error?: string };
};

function comparisonFixture(artifacts: NativeArtifact[]): ComparisonArtifact[] {
  // Comparator policy fixture only: real-store output is retained, but these zero-load values do
  // not claim that the native timings were observed on a quiet machine.
  return structuredClone(artifacts).map((artifact) => {
    // Windows load averages are unsupported. Its positive persisted-artifact fixture uses an
    // explicit supported test platform; real all-store output remains asserted separately.
    const environment = structuredClone(artifact.environment);
    if (environment.machine.platform === 'win32') {
      environment.machine.platform = 'darwin';
      environment.machine_fingerprint = identityHash(environment.machine);
      artifact.environment = structuredClone(environment);
      artifact.implementation_stability.before.environment = structuredClone(environment);
      artifact.implementation_stability.after.environment = structuredClone(environment);
    }
    return {
      ...artifact,
      readiness: {
        policy,
        environment: { entry: structuredClone(environment), exit: structuredClone(environment) },
        entry: { load1: 0, load5: 0, load15: 0, supported: true, passed: true },
        exit: { load1: 0, load5: 0, load15: 0, supported: true, passed: true },
      },
      timing: { valid: true, entry: { load1: 0, load5: 0, load15: 0 }, exit: { load1: 0, load5: 0, load15: 0 } },
    };
  });
}

function successfulSample(artifact: NativeArtifact, index: number) {
  const sample = artifact.samples[index];
  assert.ok(sample && !('error' in sample), `expected successful sample ${index + 1}`);
  return sample;
}

function lexicalSample(artifact: NativeArtifact, index: number) {
  const sample = successfulSample(artifact, index);
  assert.ok(sample.lexical);
  return sample.lexical;
}

function replaceEnvironment(artifact: ComparisonArtifact, environment: NativeArtifact['environment']) {
  artifact.environment = structuredClone(environment);
  artifact.implementation_stability.before.environment = structuredClone(environment);
  artifact.implementation_stability.after.environment = structuredClone(environment);
  artifact.readiness.environment.entry = structuredClone(environment);
  artifact.readiness.environment.exit = structuredClone(environment);
}

describe('native capability comparison preflight', () => {
  let realArtifacts: NativeArtifact[];

  before(async function () {
    this.timeout(60_000);
    realArtifacts = [];
    for (const store of STORE_NAMES) {
      realArtifacts.push(
        await runNativeCapability({
          open,
          store,
          storeNames: STORE_NAMES,
          root: scratchDir(`native-compare-${store}`),
          packageRoot,
          harnessRoot: packageRoot,
          storeDims: STORE_DIMS,
          notes: 4,
          repetitions: 3,
        })
      );
    }
  });

  it('keeps real all-store output separate from unobserved timing eligibility', () => {
    for (const artifact of realArtifacts) {
      assert.equal(artifact.valid, true);
      assert.equal(artifact.samples.length, 3);
      assert.deepEqual(successfulSample(artifact, 0).vectors.candidates, [
        { path: 'a.md', similarity: 1 },
        { path: 'b.md', similarity: Number(Math.SQRT1_2.toFixed(3)) },
        { path: 'c.md', similarity: 0 },
      ]);
    }
    const result = compareNativeCapabilityArtifacts(realArtifacts);
    assert.equal(result.eligible, false);
    assert.ok(
      result.reasons.every((reason: string) => /readiness evidence is missing/.test(reason)),
      result.reasons.join('\n')
    );
  });

  it('accepts an explicit comparator fixture only when every retained fact agrees', () => {
    const artifacts = comparisonFixture(realArtifacts);
    for (const [storeIndex, artifact] of artifacts.entries()) {
      for (const [sampleIndex, sample] of artifact.samples.entries()) {
        assert.ok(!('error' in sample));
        sample.vectors.candidates_ms = storeIndex * 10 + sampleIndex + 1;
      }
    }
    const result = compareNativeCapabilityArtifacts(artifacts);
    assert.equal(result.eligible, true, result.reasons.join('\n'));
    assert.deepEqual(Object.keys(result.common_rows), ['open', 'cold_lexical', 'warm_lexical', 'content_read', 'vector_write', 'vector_candidates', 'vector_similar']);
    const contentRead = result.common_rows.content_read;
    const coldLexical = result.common_rows.cold_lexical;
    assert.ok(contentRead && typeof contentRead.scope === 'string');
    assert.ok(coldLexical);
    assert.match(contentRead.scope, /not production search hydration/);
    assert.equal(coldLexical.lexical_row_hash_recomputed, false);
    assert.deepEqual(result.common_rows.vector_candidates.samples_ms_by_store, { sqlite: [1, 2, 3], duckdb: [11, 12, 13], turso: [21, 22, 23] });
    assert.deepEqual(result.common_rows.vector_candidates.median_ms_by_store, { sqlite: 2, duckdb: 12, turso: 22 });
  });

  it('reconstructs the narrow-vector case from its named workload identity', async function () {
    this.timeout(60_000);
    const artifacts: NativeArtifact[] = [];
    for (const store of STORE_NAMES) {
      artifacts.push(
        await runNativeCapability({
          open,
          store,
          storeNames: STORE_NAMES,
          root: scratchDir(`native-compare-narrow-${store}`),
          packageRoot,
          harnessRoot: packageRoot,
          storeDims: STORE_DIMS,
          notes: 4,
          repetitions: 3,
          caseId: 'narrow-vectors',
        })
      );
    }
    const result = compareNativeCapabilityArtifacts(comparisonFixture(artifacts));
    assert.equal(result.eligible, true, result.reasons.join('\n'));
    assert.equal(artifacts[0].case_id, 'narrow-vectors');
    assert.equal(artifacts[0].workload.inputs.requested.vector_wire_dims, 64);
    assert.equal(artifacts[0].workload.inputs.requested.native_schema_dims, STORE_DIMS);
  });

  it('rejects a same-count but incorrect structured-content fact', async function () {
    this.timeout(60_000);
    const artifacts: NativeArtifact[] = [];
    for (const store of STORE_NAMES) {
      artifacts.push(
        await runNativeCapability({
          open,
          store,
          storeNames: STORE_NAMES,
          root: scratchDir(`native-compare-structured-${store}`),
          packageRoot,
          harnessRoot: packageRoot,
          storeDims: STORE_DIMS,
          notes: 4,
          repetitions: 3,
          caseId: 'structured-content',
        })
      );
    }
    const rows = comparisonFixture(artifacts);
    const valid = compareNativeCapabilityArtifacts(rows);
    assert.equal(valid.eligible, true, valid.reasons.join('\n'));
    const sample = successfulSample(rows[0], 0);
    assert.ok(sample.structured);
    sample.structured.frontmatter[0].status = 'archived';
    const result = compareNativeCapabilityArtifacts(rows);
    assert.equal(result.eligible, false);
    assert.match(result.reasons.join('\n'), /structured facts mismatch/);
  });

  const mutations: Array<{ name: string; mutate: (rows: ComparisonArtifact[]) => void; reason: RegExp }> = [
    { name: 'wrong same-count lexical path', mutate: (rows) => (lexicalSample(rows[0], 0).first_paths[1] = 'wrong.md'), reason: /cold lexical paths mismatch/ },
    { name: 'changed row input identity', mutate: (rows) => (rows[1].row_workload_ids.open = '0'.repeat(64)), reason: /row workload identities mismatch/ },
    { name: 'changed vector tuple', mutate: (rows) => (successfulSample(rows[2], 1).vectors.candidates[1].similarity = 0.5), reason: /vector candidates mismatch/ },
    { name: 'missing repetition', mutate: (rows) => void rows[0].samples.pop(), reason: /samples do not match repetitions/ },
    { name: 'wrong repetition state', mutate: (rows) => (successfulSample(rows[0], 0).state.index = 'warm'), reason: /state mismatch/ },
    {
      name: 'different machine',
      mutate: (rows) => {
        const environment = structuredClone(rows[1].environment);
        environment.machine.cpu_model = 'different';
        environment.machine_fingerprint = identityHash(environment.machine);
        replaceEnvironment(rows[1], environment);
      },
      reason: /machine identity differs/,
    },
    {
      name: 'different Node runtime',
      mutate: (rows) => {
        const environment = structuredClone(rows[2].environment);
        environment.runtime.node = 'v0.0.0';
        replaceEnvironment(rows[2], environment);
        rows[2].provenance.runtime.node = 'v0.0.0';
        for (const observation of [rows[2].implementation_stability.before, rows[2].implementation_stability.after]) {
          observation.runtime.node = 'v0.0.0';
        }
      },
      reason: /runtime Node version differs/,
    },
    { name: 'failed readiness', mutate: (rows) => (rows[0].readiness.exit.passed = false), reason: /exit readiness pass contradicts/ },
    {
      name: 'different readiness machine snapshot',
      mutate: (rows) => {
        rows[0].readiness.environment.entry.machine.logical_cores += 1;
      },
      reason: /entry readiness environment mismatch/,
    },
    {
      name: 'unsupported readiness policy',
      mutate: (rows) => {
        const unsupported = { method: 'always quiet', max_load_per_logical_core: 1, unsupported_platforms: ['win32'] };
        rows[0].readiness.policy = { ...unsupported, fingerprint: identityHash(unsupported) };
      },
      reason: /readiness policy mismatch/,
    },
    {
      name: 'excessive load claimed ready',
      mutate: (rows) => {
        const excessive = rows[0].environment.machine.logical_cores;
        rows[0].readiness.entry.load1 = excessive;
        rows[0].timing.entry.load1 = excessive;
      },
      reason: /entry readiness pass contradicts/,
    },
    {
      name: 'malformed core observation',
      mutate: (rows) => {
        const environment = structuredClone(rows[0].environment);
        environment.machine.logical_cores = 0;
        environment.machine_fingerprint = identityHash(environment.machine);
        replaceEnvironment(rows[0], environment);
      },
      reason: /logical cores are invalid/,
    },
    { name: 'contradictory timing evidence', mutate: (rows) => (rows[0].timing.exit.load5 = 1), reason: /exit timing\/readiness observation mismatch/ },
    { name: 'timing error on a valid-shaped artifact', mutate: (rows) => (rows[0].timing.error = 'measurement failed'), reason: /timing carries an error/ },
    { name: 'missing success status', mutate: (rows) => delete (rows[0] as Partial<NativeArtifact>).status, reason: /artifact status is not successful/ },
    { name: 'failure status on a valid-shaped artifact', mutate: (rows) => Object.assign(rows[0], { status: 'invalid-measurement' }), reason: /artifact status is not successful/ },
    { name: 'stale measure version', mutate: (rows) => (rows[1].measure_version = 'fixture-old'), reason: /duckdb measure_version fixture-old does not match current/ },
    { name: 'sample error on a valid-shaped repetition', mutate: (rows) => Object.assign(successfulSample(rows[0], 0), { error: 'sample failed' }), reason: /repetition 1 carries an error/ },
    {
      name: 'disconnected stable runtime evidence',
      mutate: (rows) => {
        for (const observation of [rows[0].implementation_stability.before, rows[0].implementation_stability.after]) observation.runtime.node = 'v0.0.0';
      },
      reason: /runtime Node observations disagree/,
    },
    {
      name: 'unknown native package version',
      mutate: (rows) => {
        const nativePackage = rows[1].provenance.native.package;
        assert.ok(nativePackage);
        nativePackage.version = 'unknown';
        for (const observation of [rows[1].implementation_stability.before, rows[1].implementation_stability.after]) {
          assert.ok(observation.native_package);
          observation.native_package.version = 'unknown';
        }
      },
      reason: /optional native package version is unknown/,
    },
    {
      name: 'native package changed during measurement',
      mutate: (rows) => {
        const after = rows[1].implementation_stability.after.native_package;
        const recorded = rows[1].provenance.native.package;
        assert.ok(after && recorded);
        after.version = 'changed';
        recorded.version = 'changed';
      },
      reason: /implementation stability evidence disagrees/,
    },
    { name: 'negative timing', mutate: (rows) => (lexicalSample(rows[0], 0).first_ms = -1), reason: /must be finite and nonnegative/ },
    { name: 'hostile note count', mutate: (rows) => (rows[0].notes = 1_000_000_000), reason: /note count is invalid/ },
    { name: 'hostile vector dimensions', mutate: (rows) => (rows[0].workload.inputs.requested.vector_dims = 1_000_000_000), reason: /vector dimensions are unsupported/ },
  ];
  for (const { name, mutate, reason } of mutations) {
    it(`rejects ${name}`, () => {
      const rows = comparisonFixture(realArtifacts);
      mutate(rows);
      const result = compareNativeCapabilityArtifacts(rows);
      assert.equal(result.eligible, false);
      assert.match(result.reasons.join('\n'), reason);
    });
  }

  it('rejects historical, duplicate-store, and incomplete store sets without inference', () => {
    const historical = comparisonFixture(realArtifacts);
    historical[0].schema = 'native-capability-v1';
    assert.match(compareNativeCapabilityArtifacts(historical).reasons.join('\n'), /unsupported schema native-capability-v1/);

    const duplicate = comparisonFixture(realArtifacts);
    duplicate[2].store = 'duckdb';
    assert.equal(compareNativeCapabilityArtifacts(duplicate).eligible, false);

    assert.match(compareNativeCapabilityArtifacts(comparisonFixture(realArtifacts).slice(0, 2)).reasons.join('\n'), /store set must be/);
  });

  it('evaluates the real current readiness observation without assuming it passes', () => {
    const environment = nativeCapabilityEnvironment();
    const load1 = loadavg()[0];
    const observed = quietMachineCheck(load1, environment.machine.logical_cores);
    assert.equal(observed.blocked, load1 > environment.machine.logical_cores / 2);
    assert.equal(environment.machine_fingerprint, identityHash(environment.machine));
  });

  it('renders valid and malformed persisted comparison inputs through the bounded CLI', () => {
    const root = scratchDir('native-comparison-cli');
    const files = comparisonFixture(realArtifacts).map((artifact, index) => {
      const path = join(root, `${index}.json`);
      writeFileSync(path, JSON.stringify(artifact));
      return path;
    });
    const tool = join(packageRoot, 'benchmark/tools/native-capability-compare.mjs');
    const valid = spawnSync(process.execPath, [tool, ...files], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(valid.error, undefined, valid.error?.message ?? 'valid comparison CLI spawn failed');
    assert.equal(valid.signal, null);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(JSON.parse(valid.stdout).eligible, true);

    writeFileSync(files[0], '{ malformed');
    const output = join(root, 'ineligible.json');
    const malformed = spawnSync(process.execPath, [tool, ...files, '--out', output], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(malformed.error, undefined, malformed.error?.message ?? 'malformed comparison CLI spawn failed');
    assert.equal(malformed.signal, null);
    assert.equal(malformed.status, 1, malformed.stderr);
    const rendered = JSON.parse(malformed.stdout);
    assert.equal(rendered.eligible, false);
    assert.match(rendered.reasons.join('\n'), /input preflight failed/);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), rendered);
  });
});
