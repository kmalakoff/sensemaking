import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../../benchmark/lib/fixed-work-measurement.mjs';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { NATIVE_CAPABILITY_READINESS_POLICY, nativeCapabilityEnvironment } from '../../benchmark/lib/native-capability.mjs';
import { compareNativeUpdateArtifacts, NATIVE_UPDATE_COUNTS, NATIVE_UPDATE_SCHEMA, NATIVE_UPDATE_STORES, nativeComparisonSucceeded, nativeEvidenceExecutionPlan, nativeEvidenceSchedule, nativeUpdateInputs, nativeUpdatePaths } from '../../benchmark/lib/native-update-contract.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

function updateComparisonFixture(store: string, changed = 250) {
  const environment = nativeCapabilityEnvironment();
  const entry = readinessObservation(environment, [0, 0, 0]);
  const exit = readinessObservation(environment, [0, 0, 0]);
  const nativeObservation = {
    status: 'recorded',
    version_query: store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version',
    version: 'fixture-native-version',
    capabilities: [],
  };
  const provenance = fixedWorkProvenance({
    packageRoot,
    harnessFiles: [
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
    ],
    store,
    nativeObservation,
  });
  const stable = stableFixedWorkIdentity(provenance, environment);
  const inputs = nativeUpdateInputs(changed);
  const samples = [1, 2, 3].map((repetition) => ({
    repetition,
    ms: 3,
    open_ms: 1,
    first_lexical_ms: 1,
    warm_lexical_ms: 1,
    note_count: 260,
    changed_paths: nativeUpdatePaths(changed),
    initial_baseline_paths: nativeUpdatePaths(260),
    first_updated_paths: nativeUpdatePaths(changed),
    warm_updated_paths: nativeUpdatePaths(changed),
    post_update_baseline_paths: nativeUpdatePaths(260),
  }));
  return {
    schema: NATIVE_UPDATE_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: 'success',
    valid: true,
    errors: [] as string[],
    store,
    changed,
    repetitions: 3,
    workload: { inputs, fingerprint: identityHash(inputs) },
    expected: { changed_paths: nativeUpdatePaths(changed), notes: 260 },
    samples,
    median_ms: 3,
    readiness: fixedWorkReadiness(entry, exit),
    environment,
    provenance,
    implementation_stability: { stable: true, before: stable, after: stable },
  };
}

describe('native update threshold evidence', () => {
  it('defines the bounded, warmed 260-note workload around the threshold', () => {
    assert.deepEqual(NATIVE_UPDATE_COUNTS, [249, 250, 251]);
    assert.deepEqual(NATIVE_UPDATE_STORES, ['sqlite', 'duckdb', 'turso']);
    const inputs = nativeUpdateInputs(250);
    assert.equal(inputs.notes, 260);
    assert.deepEqual(inputs.changed_paths, nativeUpdatePaths(250));
    assert.equal(inputs.initial_lexical_state, 'built and queried once before close');
    assert.equal(inputs.measured_lexical_state, 'first and second queries after the measured update open');
    assert.deepEqual(inputs.config.presets.default.include, ['**/*.md']);
    assert.equal(inputs.config.baseDir, '<temporary-authored-corpus>');
    assert.deepEqual(inputs.queries.changed.options, { whereJoin: '', whereCond: '', scopeCond: '', limit: 260 });
    assert.equal(inputs.corpus.baseline.files.length, 260);
    assert.equal(inputs.corpus.changed.files[0].text, '# Note 0\n\nbaseline token 0 updated marker\n');
    assert.equal(inputs.corpus.changed.files[250].text, '# Note 250\n\nbaseline token 250\n');
    assert.equal(inputs.corpus.baseline.fingerprint, identityHash(inputs.corpus.baseline.files));
    assert.equal(inputs.corpus.changed.fingerprint, identityHash(inputs.corpus.changed.files));
    assert.equal(identityHash(inputs), identityHash({ ...inputs }));
    assert.throws(() => nativeUpdateInputs(248), /changed files must be one of 249, 250, 251/);
  });

  it('builds the exact bounded capability and update schedule', () => {
    const schedule = nativeEvidenceSchedule(6);
    assert.equal(schedule.length, 33);
    assert.deepEqual(
      schedule.slice(0, 21),
      ['baseline', 'large-content', 'dense-terms', 'broad-matches', 'top-one', 'narrow-vectors', 'structured-content'].flatMap((case_id) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability', case_id, notes: case_id === 'structured-content' ? 5 : 4, store })))
    );
    assert.deepEqual(
      schedule.slice(21, 24),
      NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-capability', case_id: 'baseline', notes: 6, store }))
    );
    assert.deepEqual(
      schedule.slice(24),
      NATIVE_UPDATE_COUNTS.flatMap((changed) => NATIVE_UPDATE_STORES.map((store) => ({ kind: 'native-update', changed, notes: 260, store })))
    );
    const plan = nativeEvidenceExecutionPlan(6);
    assert.equal(plan.producers.length, 33);
    assert.equal(plan.comparators.length, 11);
    assert.deepEqual(
      plan.comparators.map(({ id }) => id),
      ['capability-baseline-4', 'capability-large-content-4', 'capability-dense-terms-4', 'capability-broad-matches-4', 'capability-top-one-4', 'capability-narrow-vectors-4', 'capability-structured-content-5', 'capability-baseline-6', 'update-249', 'update-250', 'update-251']
    );
    assert.equal(new Set(plan.comparators.map(({ id }) => id)).size, 11);
    assert.equal(nativeComparisonSucceeded('native-capability', { schema: 'native-capability-comparison-v1', eligible: true, reasons: [] }), true);
    assert.equal(nativeComparisonSucceeded('native-capability', { schema: 'native-capability-comparison-v1', eligible: true, reasons: ['tampered'] }), false);
    assert.equal(nativeComparisonSucceeded('native-update', { schema: 'native-update-threshold-comparison-v1', status: 'success', valid: true, errors: [] }), true);
    assert.equal(nativeComparisonSucceeded('native-update', { schema: 'native-update-threshold-comparison-v1', status: 'success', valid: true, errors: ['tampered'] }), false);
  });

  it('retains distinct artifacts at the five-note baseline boundary', () => {
    const dir = scratchDir('native-matrix-five');
    const plan = nativeEvidenceExecutionPlan(5);
    const outputs = plan.comparators.flatMap((group) => [...group.artifact_files, group.comparison_file]);
    assert.equal(outputs.length, 44);
    assert.equal(new Set(outputs).size, outputs.length);
    for (const group of plan.comparators) {
      for (const filename of [...group.artifact_files, group.comparison_file]) writeFileSync(join(dir, filename), group.id);
    }
    for (const group of plan.comparators) {
      for (const filename of [...group.artifact_files, group.comparison_file]) assert.equal(readFileSync(join(dir, filename), 'utf8'), group.id);
    }
    assert.ok(outputs.includes('capability-structured-content-5-sqlite.json'));
    assert.ok(outputs.includes('capability-baseline-5-sqlite.json'));
  });

  it('requires explicit success before accepting persisted update artifacts', () => {
    const artifacts = NATIVE_UPDATE_STORES.map((store) => ({ schema: NATIVE_UPDATE_SCHEMA, measure_version: MEASURE_VERSION, store, status: 'invalid', valid: false, errors: ['measurement failed'] }));
    const result = compareNativeUpdateArtifacts(artifacts);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /artifact is not successful/);
  });

  it('accepts independent correctness fixtures and rejects identity/postcondition tampering', () => {
    const validRows = NATIVE_UPDATE_STORES.map((store) => updateComparisonFixture(store));
    const valid = compareNativeUpdateArtifacts(validRows);
    if (NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(process.platform)) {
      assert.equal(valid.valid, false);
      assert.match(valid.errors.join('\n'), /entry readiness is unsupported/);
      return;
    }
    assert.equal(valid.valid, true, valid.errors.join('\n'));

    const mutations: Array<{ mutate: (rows: ReturnType<typeof updateComparisonFixture>[]) => void; reason: RegExp }> = [
      {
        mutate: (rows) => {
          rows[0].workload.inputs.queries.changed.text = 'wrong';
          rows[0].workload.fingerprint = identityHash(rows[0].workload.inputs);
        },
        reason: /workload mismatch/,
      },
      { mutate: (rows) => (rows[1].expected.changed_paths[0] = 'wrong.md'), reason: /expected output mismatch/ },
      { mutate: (rows) => (rows[2].samples[0].changed_paths[0] = 'wrong.md'), reason: /changed paths mismatch/ },
      { mutate: (rows) => (rows[0].samples[0].post_update_baseline_paths[0] = 'wrong.md'), reason: /baseline lexical paths/ },
      { mutate: (rows) => (rows[0].samples[0].warm_updated_paths[0] = 'wrong.md'), reason: /updated lexical paths/ },
      { mutate: (rows) => (rows[0].samples[0].ms = 4), reason: /timing total does not recompute/ },
      { mutate: (rows) => (rows[0].errors = ['late warning']), reason: /nonempty errors/ },
      {
        mutate: (rows) => {
          rows[0].readiness.environment.entry.machine.cpu_model = 'tampered';
          rows[0].readiness.environment.entry.machine_fingerprint = identityHash(rows[0].readiness.environment.entry.machine);
        },
        reason: /readiness entry environment mismatch|environment differs/,
      },
      { mutate: (rows) => (rows[0].implementation_stability.before = { ...rows[0].implementation_stability.before, runtime: { node: 'v0.0.0' } }), reason: /implementation stability(?: environment)? mismatch/ },
      {
        mutate: (rows) => {
          const nativePackage = rows[1].provenance.native.package;
          assert.ok(nativePackage);
          nativePackage.name = '@wrong/package';
        },
        reason: /native package identity is wrong/,
      },
      { mutate: (rows) => (rows[0].implementation_stability.after.runtime.node = 'v0.0.0'), reason: /runtime provenance mismatch|implementation stability/ },
    ];
    for (const { mutate, reason } of mutations) {
      const rows = NATIVE_UPDATE_STORES.map((store) => updateComparisonFixture(store));
      mutate(rows);
      const result = compareNativeUpdateArtifacts(rows);
      assert.equal(result.valid, false);
      assert.match(result.errors.join('\n'), reason);
    }
  });

  it('propagates command and comparator failures instead of producing a valid artifact', () => {
    const tool = join(packageRoot, 'benchmark/tools/native-update.mjs');
    const badArguments = spawnSync(process.execPath, [tool, '--store', 'sqlite', '--changed', '248'], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(badArguments.status, 2);
    assert.match(`${badArguments.stdout}\n${badArguments.stderr}`, /usage:/);

    const dir = scratchDir('native-update-cli-error');
    const malformed = join(dir, 'malformed.json');
    writeFileSync(malformed, '{ malformed');
    const comparison = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/native-update-compare.mjs'), malformed, malformed, malformed], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(comparison.status, 1);
    assert.match(`${comparison.stdout}\n${comparison.stderr}`, /Unexpected token|JSON/);

    const matrix = join(packageRoot, 'benchmark/tools/native-evidence-matrix.mjs');
    const help = spawnSync(process.execPath, [matrix, '--help'], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(help.status, 0);
    assert.match(help.stderr, /native-evidence-matrix/);
    const invalidBaseline = spawnSync(process.execPath, [matrix, '--baseline-notes', '3'], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(invalidBaseline.status, 2);
    assert.match(`${invalidBaseline.stdout}\n${invalidBaseline.stderr}`, /baseline-notes/);

    const reused = scratchDir('native-matrix-reused');
    writeFileSync(join(reused, 'stale-success.json'), '{}');
    const reusedRun = spawnSync(process.execPath, [matrix, '--out-dir', reused], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(reusedRun.status, 2);
    assert.match(`${reusedRun.stdout}\n${reusedRun.stderr}`, /new empty directory/);

    const preflight = scratchDir('native-update-input-preflight');
    const oversized = join(preflight, 'oversized.json');
    writeFileSync(oversized, '');
    truncateSync(oversized, 16 * 1024 * 1024 + 1);
    const oversizedRun = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/native-update-compare.mjs'), oversized, oversized, oversized], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(oversizedRun.status, 1);
    assert.match(`${oversizedRun.stdout}\n${oversizedRun.stderr}`, /exceeds 16777216/);
    const linked = join(preflight, 'linked.json');
    symlinkSync(oversized, linked);
    const linkedRun = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/native-update-compare.mjs'), linked, linked, linked], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 });
    assert.equal(linkedRun.status, 1);
    assert.match(`${linkedRun.stdout}\n${linkedRun.stderr}`, /not a regular file/);
  });
});
