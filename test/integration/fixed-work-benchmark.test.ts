import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { open } from 'sensemaking';
import { FIXED_HYDRATION_CANDIDATES, FIXED_HYDRATION_CASES, FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_FILES, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_LINES, FIXED_HYDRATION_SECTIONS, FIXED_HYDRATION_TERMS } from '../../benchmark/lib/fixed-hydration-workload.mjs';
import { validateFixedWorkArtifact } from '../../benchmark/lib/fixed-work-measurement.mjs';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { NATIVE_CAPABILITY_READINESS_POLICY } from '../../benchmark/lib/native-capability.mjs';
import { compareNativeHydrationArtifacts, NATIVE_HYDRATION_HARNESS_FILES, NATIVE_HYDRATION_REPETITIONS, NATIVE_HYDRATION_SCHEMA } from '../../benchmark/lib/native-hydration-compare.mjs';
import { quietMachineCheck } from '../../benchmark/lib/quiet-machine.mjs';
import { SHARED_SNIPPET_SCHEMA, validateSharedSnippetArtifact } from '../../benchmark/lib/shared-snippet-contract.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { computeSnippets, hydrateSearchRows, lineNumberAt } from '../../src/commands/search.ts';
import type { ResolvedConfig } from '../../src/config/types.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore } from '../lib/stores.ts';

type HydrationRow = { path: string; snippets?: string[]; lines?: string };

function runTool(args: string[], out: string): { artifact: Record<string, unknown>; status: number | null } {
  const result = spawnSync(process.execPath, [...args, '--out', out], { cwd: packageRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message ?? 'tool spawn failed');
  assert.equal(result.signal, null, `tool was terminated by ${result.signal}`);
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  return { artifact: JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>, status: result.status };
}

function assertSharedSnippetReadinessFailure({ artifact, status }: ReturnType<typeof runTool>) {
  assert.equal(status, 1);
  assert.equal(artifact.schema, SHARED_SNIPPET_SCHEMA);
  assert.equal(artifact.measure_version, MEASURE_VERSION);
  assert.equal(artifact.status, 'invalid');
  assert.equal(artifact.valid, false);
  assert.ok(Array.isArray(artifact.errors) && artifact.errors.length > 0, 'readiness failure must name its errors');
  for (const error of artifact.errors) {
    assert.equal(typeof error, 'string');
    assert.match(error, /^quiet-machine (?:preflight refused on [a-z0-9]+: load|readiness lost: load) \d+(?:\.\d+)?$/);
    assert.equal(error.trim(), error);
  }
  assert.throws(() => validateSharedSnippetArtifact(artifact), /artifact is not successful/);
}

function hydrationArtifacts() {
  // These persisted-artifact values are authored comparator inputs, never measured timings or
  // observations of this host. Real native output is checked separately below.
  const machine = { platform: 'darwin', logical_cores: 8, cpu_model: 'authored fixture' };
  const environment = { machine, machine_fingerprint: identityHash(machine), runtime: { node: 'v26.0.0-fixture' } };
  const observation = { load1: 0, load5: 0, load15: 0, supported: true, passed: true };
  const inputs = { ...FIXED_HYDRATION_INPUTS, operation: 'production hydration over fixed ordered candidates and caller snippet budgets' };
  return ['sqlite', 'duckdb', 'turso'].map((store) => {
    const provenance = {
      measured_package: { version: 'fixture', dist: { status: 'recorded', fingerprint: identityHash('fixture dist') } },
      harness: { files: NATIVE_HYDRATION_HARNESS_FILES.length, paths: [...NATIVE_HYDRATION_HARNESS_FILES].sort(), fingerprint: identityHash('fixture harness') },
      runtime: environment.runtime,
      native: { store, package: { version: '1.0.0-fixture' }, observation: { version_query: store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version', version: 'fixture-native', capabilities: [] } },
    };
    const stable = { measured_package: provenance.measured_package, harness: provenance.harness, runtime: provenance.runtime, native_package: provenance.native.package, environment };
    return structuredClone({
      schema: NATIVE_HYDRATION_SCHEMA,
      measure_version: MEASURE_VERSION,
      store,
      case_id: 'fixed-shapes-and-budgets',
      status: 'success',
      valid: true,
      errors: [] as string[],
      repetitions: NATIVE_HYDRATION_REPETITIONS,
      workload: { inputs, fingerprint: identityHash(inputs) },
      expected: { sections: structuredClone(FIXED_HYDRATION_SECTIONS), rows_by_case: structuredClone(FIXED_HYDRATION_EXPECTED) },
      samples: [3, 1, 2].map((ms, index) => ({ repetition: index + 1, ms, candidate_order: [...FIXED_HYDRATION_CANDIDATES], rows_by_case: structuredClone(FIXED_HYDRATION_EXPECTED), sections: structuredClone(FIXED_HYDRATION_SECTIONS) })),
      median_ms: 2,
      environment,
      provenance,
      implementation_stability: { stable: true, before: structuredClone(stable), after: structuredClone(stable) },
      readiness: {
        policy: { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) },
        environment: { entry: structuredClone(environment), exit: structuredClone(environment) as typeof environment | null },
        entry: { ...observation },
        exit: { ...observation } as typeof observation | null,
      },
    });
  });
}

function validateHydrationArtifact(artifact: Record<string, unknown>) {
  // The JavaScript default infers null, although the validator accepts and checks native stores.
  const validate = validateFixedWorkArtifact as unknown as (value: Record<string, unknown>, options: { schema: string; repetitions: number; harnessFiles: readonly string[]; store: string }) => unknown;
  return validate(artifact, { schema: NATIVE_HYDRATION_SCHEMA, repetitions: NATIVE_HYDRATION_REPETITIONS, harnessFiles: NATIVE_HYDRATION_HARNESS_FILES, store: artifact.store as string });
}

function assertHydrationReadinessFailure({ artifact, status }: ReturnType<typeof runTool>) {
  assert.equal(status, 1);
  assert.equal(artifact.schema, NATIVE_HYDRATION_SCHEMA);
  assert.equal(artifact.measure_version, MEASURE_VERSION);
  assert.equal(artifact.valid, false);
  const readiness = artifact.readiness as ReturnType<typeof hydrationArtifacts>[number]['readiness'];
  assert.ok(readiness?.entry);
  assert.deepEqual(readiness.policy, { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) });
  let expectedError: string;
  if (artifact.status === 'refused-preflight') {
    const { machine } = readiness.environment.entry;
    const supported = !NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(machine.platform);
    assert.equal(readiness.entry.supported, supported);
    assert.equal(readiness.entry.passed, false);
    assert.ok(!supported || quietMachineCheck(readiness.entry.load1, machine.logical_cores).blocked);
    assert.equal(readiness.exit, null);
    assert.equal(readiness.environment.exit, null);
    assert.deepEqual(artifact.provenance, { status: 'unavailable-before-build-or-import' });
    assert.equal('samples' in artifact, false);
    assert.equal('median_ms' in artifact, false);
    expectedError = `quiet-machine preflight refused on ${machine.platform}: load ${readiness.entry.load1}`;
  } else {
    assert.equal(artifact.status, 'invalid');
    assert.equal(readiness.entry.supported, true);
    assert.equal(readiness.entry.passed, true);
    assert.ok(readiness.exit && readiness.environment.exit);
    assert.equal(readiness.exit.supported, true);
    assert.equal(readiness.exit.passed, false);
    assert.ok(quietMachineCheck(readiness.exit.load1, readiness.environment.exit.machine.logical_cores).blocked);
    expectedError = `quiet-machine readiness lost: load ${readiness.exit.load1}`;
  }
  assert.ok(Array.isArray(artifact.errors) && artifact.errors.length > 0);
  for (const error of artifact.errors) assert.equal(error, expectedError);
  assert.throws(() => validateHydrationArtifact(artifact), /artifact is not successful/);
  const comparison = compareNativeHydrationArtifacts([artifact]);
  assert.equal(comparison.valid, false);
  assert.equal('samples_ms_by_store' in comparison, false);
  assert.equal('median_ms_by_store' in comparison, false);
}

describe('fixed-work benchmark artifacts', () => {
  it('checks every authored snippet and line before timing can qualify', () => {
    const denseWords = FIXED_HYDRATION_FILES['d.md'].trim().split(/\s+/);
    assert.ok(denseWords.length > 250_000, 'the dense large note must exercise at least 250,000 word boundaries');
    assert.ok(
      denseWords.every((word) => word.length < 20),
      'a single giant word is not the dense-word workload'
    );
    for (const { id, char_limit: charLimit, count_limit: countLimit } of FIXED_HYDRATION_CASES) {
      for (const path of FIXED_HYDRATION_CANDIDATES) {
        const text = FIXED_HYDRATION_FILES[path as keyof typeof FIXED_HYDRATION_FILES];
        const result = computeSnippets(text, FIXED_HYDRATION_TERMS, charLimit, countLimit);
        assert.deepEqual(result.snippets, FIXED_HYDRATION_EXPECTED[id as keyof typeof FIXED_HYDRATION_EXPECTED][path as keyof typeof FIXED_HYDRATION_LINES].snippets, `${id} ${path}`);
        assert.equal(lineNumberAt(text, result.offset), FIXED_HYDRATION_LINES[path as keyof typeof FIXED_HYDRATION_LINES], `${id} ${path} line`);
      }
    }
    assert.equal(Buffer.byteLength(FIXED_HYDRATION_FILES['d.md']), 1024 * 1024);
  });

  it('hydrates the identical fixed candidates through every real store', async function () {
    this.timeout(60_000);
    await forEachStore(async (storeName) => {
      const tree = scratchDir(`fixed-hydration-${storeName}`);
      for (const [path, text] of Object.entries(FIXED_HYDRATION_FILES)) writeFileSync(join(tree, path), text);
      const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null, store: storeName } as ResolvedConfig;
      const opened = await open(cfg);
      try {
        const sections = {} as Record<string, string | string[]>;
        for (const path of FIXED_HYDRATION_CANDIDATES) {
          const found = ((await (await opened.store.prepare('SELECT start_line, end_line FROM sections WHERE "path" = ? ORDER BY start_line')).all(path)) as Array<{ start_line: number; end_line: number }>).map((row) => `L${row.start_line}-${row.end_line}`);
          sections[path] = found.length === 1 ? found[0] : found;
        }
        assert.deepEqual(sections, FIXED_HYDRATION_SECTIONS, `${storeName} sections`);
        for (const { id, char_limit: snippetCharLimit, count_limit: snippetCountLimit } of FIXED_HYDRATION_CASES) {
          const rows: HydrationRow[] = FIXED_HYDRATION_CANDIDATES.map((path) => ({ path }));
          await hydrateSearchRows(opened.store, cfg, rows, new Set(FIXED_HYDRATION_CANDIDATES), FIXED_HYDRATION_TERMS[0], { snippetCharLimit, snippetCountLimit });
          assert.deepEqual(Object.fromEntries(rows.map((row) => [row.path, { snippets: row.snippets, lines: row.lines }])), FIXED_HYDRATION_EXPECTED[id as keyof typeof FIXED_HYDRATION_EXPECTED], `${storeName} ${id}`);
        }
      } finally {
        await opened.store.close();
      }
    });
  });

  it('runs validity artifacts before the release comparison without adding timing rows', () => {
    const baseline = buildStages().find(({ id }) => id === 'baseline');
    assert.deepEqual(
      baseline?.steps.slice(0, 5).map(({ id }) => id),
      ['shared-snippet', 'native-hydration-sqlite', 'native-hydration-duckdb', 'native-hydration-turso', 'native-hydration-comparison']
    );
    assert.equal(baseline?.steps[5]?.id, 'result-sets-hub');
    assert.equal(baseline?.steps[6]?.id, 'compare');
    assert.deepEqual(
      baseline?.steps.filter(({ id }) => id.startsWith('result-sets-')),
      [{ id: 'result-sets-hub', argv: ['node', 'benchmark/tools/result-sets.mjs', 'obsidian-hub'], timeout: 15 * 60_000, quiet: false, owedBy: 'baseline', out: true }]
    );
    assert.ok(baseline?.steps.slice(0, 4).every((step) => step.quiet && 'out' in step && step.out));
    assert.equal(baseline?.steps[4].quiet, false);

    const scale = buildStages().find(({ id }) => id === 'scale');
    assert.equal(scale?.steps[0]?.id, 'result-sets-stress');
    assert.equal(scale?.steps[1]?.id, 'scale-13k');
    assert.deepEqual(
      scale?.steps.filter(({ id }) => id.startsWith('result-sets-')),
      [{ id: 'result-sets-stress', argv: ['node', 'benchmark/tools/result-sets.mjs', 'stress'], timeout: 15 * 60_000, quiet: false, owedBy: 'scale', out: true }]
    );
  });

  it('measures shared snippet work once against its authored output', () => {
    const out = join(scratchDir('shared-snippet-tool'), 'artifact.json');
    const { artifact, status } = runTool([join(packageRoot, 'benchmark/tools/shared-snippet.mjs')], out);
    if (status === 0) validateSharedSnippetArtifact(artifact);
    else assertSharedSnippetReadinessFailure({ artifact, status });
  });

  it('keeps shared snippet preflight refusal and postflight readiness loss invalid', () => {
    for (const error of ['quiet-machine preflight refused on linux: load 2.24', 'quiet-machine readiness lost: load 2.24']) {
      assertSharedSnippetReadinessFailure({ status: 1, artifact: { schema: 'shared-snippet-v2', measure_version: MEASURE_VERSION, status: 'invalid', valid: false, errors: [error] } });
    }
  });

  it('rejects unrelated or mixed shared snippet errors and invalid failure records', () => {
    const failure = { status: 1, artifact: { schema: 'shared-snippet-v2', measure_version: MEASURE_VERSION, status: 'invalid', valid: false, errors: ['quiet-machine readiness lost: load 2.24'] } };
    const cases = [
      { ...failure, status: 0 },
      { ...failure, status: null },
      ...[
        { schema: 'fixture-old' },
        { measure_version: 'fixture-old' },
        { status: 'success' },
        { valid: true },
        { errors: [] },
        { errors: 'quiet-machine readiness lost: load 2.24' },
        { errors: [null] },
        { errors: ['implementation identity changed during measurement'] },
        { errors: ['quiet-machine readiness lost: load 2.24', 'repetition 1: wrong output'] },
        { errors: ['close: native failure', 'quiet-machine readiness lost: load 2.24'] },
        { errors: ['unexpected quiet-machine readiness lost: load 2.24'] },
        { errors: ['quiet-machine readiness lost: load 2.24; cleanup failed'] },
        { errors: ['quiet-machine readiness lost: load 2.24\n'] },
      ].map((changed) => ({ ...failure, artifact: { ...failure.artifact, ...changed } })),
    ];
    for (const record of cases) assert.throws(() => assertSharedSnippetReadinessFailure(record), assert.AssertionError);
  });

  it('compares exact production hydration of one fixed candidate sequence across real stores', () => {
    const dir = scratchDir('native-hydration-tools');
    const observed = ['sqlite', 'duckdb', 'turso'].map((store) => runTool([join(packageRoot, 'benchmark/tools/native-hydration.mjs'), '--store', store], join(dir, `native-hydration-${store}.json`)));
    for (const [index, record] of observed.entries()) {
      assert.equal(record.artifact.store, ['sqlite', 'duckdb', 'turso'][index]);
      if (record.status === 0) {
        assert.deepEqual(record.artifact.errors, []);
        validateHydrationArtifact(record.artifact);
      } else assertHydrationReadinessFailure(record);
    }
    if (observed.some(({ status }) => status !== 0)) return;
    const artifacts = observed.map(({ artifact }) => artifact);
    const comparison = compareNativeHydrationArtifacts(artifacts);
    assert.equal(comparison.valid, true, comparison.errors.join('\n'));
    assert.deepEqual(comparison.stores, ['duckdb', 'sqlite', 'turso']);
    assert.deepEqual(Object.keys(comparison.samples_ms_by_store).sort(), ['duckdb', 'sqlite', 'turso']);
    assert.match(comparison.scope, /excludes ranking/);
    const cliOut = join(dir, 'native-hydration-comparison.json');
    const cli = runTool([join(packageRoot, 'benchmark/tools/native-hydration-compare.mjs')], cliOut);
    assert.equal(cli.status, 0);
    assert.deepEqual(cli.artifact, comparison);
  });

  it('qualifies independently authored three-store artifacts before testing rejection', () => {
    const artifacts = hydrationArtifacts();
    for (const artifact of artifacts) validateHydrationArtifact(artifact);
    const comparison = compareNativeHydrationArtifacts(artifacts);
    assert.equal(comparison.valid, true, comparison.errors.join('\n'));
    assert.deepEqual(comparison.stores, ['duckdb', 'sqlite', 'turso']);
    assert.deepEqual(comparison.samples_ms_by_store, { sqlite: [3, 1, 2], duckdb: [3, 1, 2], turso: [3, 1, 2] });
    assert.deepEqual(comparison.median_ms_by_store, { sqlite: 2, duckdb: 2, turso: 2 });
  });

  const mutations: Array<[string, (artifact: ReturnType<typeof hydrationArtifacts>[number]) => void, RegExp, number?]> = [
    [
      'measure version',
      (value) => {
        value.measure_version = 'fixture-old';
      },
      /sqlite: measure_version fixture-old does not match current/,
    ],
    [
      'same-count wrong source path',
      (value) => {
        value.workload.inputs.files['wrong.md'] = value.workload.inputs.files['a.md'];
        delete value.workload.inputs.files['a.md'];
        value.workload.fingerprint = identityHash(value.workload.inputs);
      },
      /sqlite fixed workload mismatch/,
    ],
    [
      'source bytes',
      (value) => {
        value.workload.inputs.files['a.md'].sha256 = '0'.repeat(64);
        value.workload.fingerprint = identityHash(value.workload.inputs);
      },
      /sqlite fixed workload mismatch/,
    ],
    [
      'authored output',
      (value) => {
        value.expected.rows_by_case.default['a.md'].snippets = ['wrong'];
      },
      /sqlite authored expected output mismatch/,
    ],
    [
      'candidate order with complete stores',
      (value) => {
        value.samples[0].candidate_order.reverse();
      },
      /sqlite candidate order mismatch/,
    ],
    [
      'native store provenance',
      (value) => {
        value.provenance.native.store = 'duckdb';
      },
      /store provenance mismatch/,
    ],
    [
      'native version observation',
      (value) => {
        value.provenance.native.observation.version_query = 'SELECT version() AS version';
      },
      /native version observation is missing/,
    ],
    [
      'native package version',
      (value) => {
        value.provenance.native.package.version = 'unknown';
      },
      /native package version is missing/,
      1,
    ],
    [
      'failed entry readiness',
      (value) => {
        value.readiness.entry.passed = false;
      },
      /entry readiness did not pass/,
    ],
    [
      'unsupported entry readiness',
      (value) => {
        value.readiness.environment.entry.machine.platform = 'win32';
        value.readiness.environment.entry.machine_fingerprint = identityHash(value.readiness.environment.entry.machine);
      },
      /entry readiness is unsupported/,
    ],
    [
      'failed exit readiness',
      (value) => {
        assert.ok(value.readiness.exit);
        value.readiness.exit.passed = false;
      },
      /exit readiness did not pass/,
    ],
    [
      'missing exit readiness',
      (value) => {
        value.readiness.exit = null;
      },
      /exit readiness evidence is missing/,
    ],
  ];
  for (const [label, mutate, rejection, storeIndex = 0] of mutations)
    it(`rejects hydration artifact ${label} without measuring`, () => {
      const artifacts = hydrationArtifacts();
      assert.equal(compareNativeHydrationArtifacts(artifacts).valid, true, 'unmodified fixture must qualify');
      mutate(artifacts[storeIndex]);
      if (label === 'candidate order with complete stores') for (const artifact of artifacts) validateHydrationArtifact(artifact);
      const comparison = compareNativeHydrationArtifacts(artifacts);
      assert.equal(comparison.valid, false);
      assert.match(comparison.errors.join('\n'), rejection);
      assert.equal('samples_ms_by_store' in comparison, false);
      assert.equal('median_ms_by_store' in comparison, false);
    });

  it('rejects missing hydration stores with correct candidates and qualifying peer artifacts', () => {
    const artifacts = hydrationArtifacts();
    assert.equal(compareNativeHydrationArtifacts(artifacts).valid, true);
    const remaining = artifacts.slice(0, 2);
    for (const artifact of remaining) {
      validateHydrationArtifact(artifact);
      for (const sample of artifact.samples) assert.deepEqual(sample.candidate_order, FIXED_HYDRATION_CANDIDATES);
    }
    const comparison = compareNativeHydrationArtifacts(remaining);
    assert.equal(comparison.valid, false);
    assert.deepEqual(comparison.errors, ['store set must be sqlite, duckdb, turso']);
    assert.equal('samples_ms_by_store' in comparison, false);
    assert.equal('median_ms_by_store' in comparison, false);
  });

  it('keeps hydration preflight refusal and postflight loss invalid and rejects unrelated errors', () => {
    const success = hydrationArtifacts()[0];
    const preflight = {
      status: 1,
      artifact: {
        schema: NATIVE_HYDRATION_SCHEMA,
        measure_version: MEASURE_VERSION,
        store: 'sqlite',
        status: 'refused-preflight',
        valid: false,
        errors: ['quiet-machine preflight refused on darwin: load 5'],
        provenance: { status: 'unavailable-before-build-or-import' },
        readiness: { ...success.readiness, entry: { ...success.readiness.entry, load1: 5, passed: false }, exit: null, environment: { entry: success.environment, exit: null } },
      },
    };
    const unsupported = structuredClone(preflight);
    unsupported.artifact.readiness.environment.entry.machine.platform = 'win32';
    unsupported.artifact.readiness.environment.entry.machine_fingerprint = identityHash(unsupported.artifact.readiness.environment.entry.machine);
    unsupported.artifact.readiness.entry.supported = false;
    unsupported.artifact.errors = ['quiet-machine preflight refused on win32: load 5'];
    const postflight = { status: 1, artifact: { ...success, status: 'invalid', valid: false, errors: ['quiet-machine readiness lost: load 5'], readiness: { ...success.readiness, exit: { ...success.readiness.entry, load1: 5, passed: false } } } };
    for (const record of [preflight, unsupported, postflight]) {
      assertHydrationReadinessFailure(record);
      for (const error of ['repetition 1: wrong output', 'close: native failure', 'cleanup: temporary tree remains', 'final provenance: missing']) {
        for (const errors of [[error], [...record.artifact.errors, error], [error, ...record.artifact.errors]]) {
          assert.throws(() => assertHydrationReadinessFailure({ ...record, artifact: { ...record.artifact, errors } }), assert.AssertionError);
        }
      }
      for (const errors of [[], [null], [`unexpected ${record.artifact.errors[0]}`], [`${record.artifact.errors[0]}; cleanup failed`], [`${record.artifact.errors[0]}\n`]]) {
        assert.throws(() => assertHydrationReadinessFailure({ ...record, artifact: { ...record.artifact, errors } }), assert.AssertionError);
      }
    }
  });
});
