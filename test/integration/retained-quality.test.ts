import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'assert';
import { cachedCorpusPaths } from '../../benchmark/lib/corpus.ts';
import { runStageSteps } from '../../benchmark/lib/gate-runner.ts';
import { assertCompatibleSelection, profileReasons, remainingCost, resolveRetainedQualityRequirement, retainedQualityForSitting } from '../../benchmark/lib/gates.ts';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.ts';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES } from '../../benchmark/lib/portable-quality.ts';
import { qualityRetrievalIdentity } from '../../benchmark/lib/quality-retrieval-identity.ts';
import { observeQualityModel } from '../../benchmark/lib/quality-work-tree.ts';
import { inspectRetainedQuality, RETAINED_QUALITY_SCHEMA, RETAINED_QUALITY_SCOPE, retainedQualityIds, retainedQualityProducerIds } from '../../benchmark/lib/retained-quality.ts';
import { buildStages } from '../../benchmark/lib/stages.ts';
import { captureFileManifest } from '../../benchmark/lib/work-tree.ts';
import { identityHash, logicalWorkloadIdentity, manifestIdentity } from '../../benchmark/lib/workload-identity.ts';
import { buildReport, compactReleaseRecord, doneOnResume, persist, renderMarkdown } from '../../benchmark/report.ts';
import { packageRoot, scratchDir } from '../lib/tree.ts';

const PACKAGE_VERSION = '0.24.1';
type QualityArtifact = Awaited<ReturnType<typeof qualityArtifact>>;
type StageStep = ReturnType<typeof buildStages>[number]['steps'][number];

function write(root: string, path: string, value: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function currentRoot(withCorpora = true): string {
  const root = scratchDir('retained-quality-root');
  for (const path of ['src', 'dist', 'benchmark/steps/quality.ts', 'benchmark/lib/corpus.ts', 'benchmark/lib/labels.ts', 'benchmark/lib/quality.ts', 'benchmark/lib/quality-work-tree.ts', 'package.json', 'package-lock.json']) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(packageRoot, path), target, { recursive: true });
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  pkg.version = PACKAGE_VERSION;
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  for (const corpus of withCorpora ? ['nfcorpus', 'fever'] : []) {
    const key = corpus === 'nfcorpus' ? 'nfcorpus-beir-1' : 'fever-fever-1';
    write(root, `.tmp/cache/${key}/tree/doc.md`, 'alpha\n');
    write(root, `.tmp/cache/${key}/labels/queries.jsonl`, '{"_id":"q1","text":"alpha"}\n');
    write(root, `.tmp/cache/${key}/labels/test.tsv`, 'query-id\tcorpus-id\tscore\nq1\tdoc\t1\n');
  }
  return root;
}

async function qualityArtifact(root: string, corpus: string, store: string, queryForm: string, modelPath: string) {
  const { tree } = cachedCorpusPaths(corpus, join(root, '.tmp', 'cache'));
  assert.ok(tree);
  const queryEvidence = { q1: { text: 'alpha', canonical: 'alpha' } };
  const qrels = { q1: { doc: 1 } };
  const corpusIdentity = manifestIdentity(captureFileManifest(tree));
  const model = await observeQualityModel(root, { provider: 'static', model: modelPath });
  const retrieval = qualityRetrievalIdentity(root);
  const variants = Object.fromEntries(
    ['bm25-only', 'fused', 'semantic'].map((name) => {
      const config = { signals: { words: 1 }, baseDir: tree, configPath: null };
      return [
        name,
        {
          ndcg: 1,
          rr: 1,
          hit: 1,
          workload_identity: logicalWorkloadIdentity({
            corpus: corpusIdentity,
            operation: { kind: 'quality', corpus, split: 'test', k: 10, query_form: queryForm, query_evidence: queryEvidence, qrels },
            requested: { variant: name, config: { signals: { words: 1 } }, model: name === 'semantic' ? model : { status: 'not-applicable' } },
          }),
          execution: { config },
          model_observation: name === 'semantic' ? model : { status: 'not-applicable' },
          errors: 0,
          error_details: [],
          incomplete: false,
          ms_per_query: 1,
          per_query: { q1: { ndcg: 1, rr: 1, hit: 1, paths: ['doc.md'] } },
        },
      ];
    })
  );
  const cacheInputs = {
    version: 1,
    implementation: { measured_package: { version: PACKAGE_VERSION }, runtime: { node: process.version }, native: { store, package: null }, harness: {} },
    retrieval,
    model,
    source: corpusIdentity,
  };
  return {
    corpus,
    split: 'test',
    queries: 1,
    k: 10,
    store,
    source_tree: tree,
    work_tree: tree,
    measure_version: MEASURE_VERSION,
    query_form: queryForm,
    query_evidence: queryEvidence,
    qrels,
    incomplete: false,
    no_silent_change: true,
    variants,
    cache: { cache_fingerprint: identityHash(cacheInputs), cache_inputs: cacheInputs, model_after_run: model },
  };
}

async function fixture() {
  const root = currentRoot();
  const modelPath = join(root, 'model');
  write(root, 'model/model.safetensors', 'weights');
  write(root, 'model/tokenizer.json', '{}');
  const sittingsDir = scratchDir('retained-quality-sittings');
  const reportsDir = scratchDir('retained-quality-reports');
  const sourceName = '2099-01-01-source';
  const sourceDir = join(sittingsDir, sourceName);
  mkdirSync(sourceDir, { recursive: true });
  const artifacts: Record<string, QualityArtifact> = {};
  for (const corpus of ['nfcorpus', 'fever']) {
    artifacts[`eval-${corpus}`] = await qualityArtifact(root, corpus, 'sqlite', 'or-bag', modelPath);
    for (const store of PORTABLE_QUALITY_STORES) artifacts[`portable-eval-${corpus}-${store}`] = await qualityArtifact(root, corpus, store, 'bare-and', modelPath);
  }
  for (const [id, artifact] of Object.entries(artifacts)) writeFileSync(join(sourceDir, `${id}.json`), JSON.stringify(artifact));
  const stepsStatus = Object.fromEntries(Object.keys(artifacts).map((id) => [id, { id, status: 'ok', owed: true }]));
  const sourceReport = {
    date: '2099-01-01',
    sitting: sourceName,
    package_version: PACKAGE_VERSION,
    release_version: null,
    measure_version: MEASURE_VERSION,
    steps_status: stepsStatus,
    steps: artifacts,
  };
  writeFileSync(join(sourceDir, 'release-gate.json'), JSON.stringify(sourceReport));
  const retained = await inspectRetainedQuality({ reportsDir, sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: root });
  assert.equal(retained.valid, true, retained.errors.join('\n'));
  assert.ok(retained.source);

  const targetDir = join(sittingsDir, '2099-01-02-target');
  mkdirSync(targetDir, { recursive: true });
  const requirements = { 'quality-revalidation': ['ordinary baseline requires a current quality view'] };
  const sitting = {
    date: '2099-01-02',
    baseline_version: PACKAGE_VERSION,
    last_tag: 'v0.24.1',
    machine: {},
    node: process.version,
    changed_paths: ['src/output/output.ts'],
    profile: 'ordinary',
    effective_requirements: requirements,
    retained_quality: { schema: retained.schema, measure_version: retained.measure_version, scope: retained.scope, valid: true, status: 'revalidated', source: retained.source },
    owed: requirements,
    steps: { validate: { id: 'validate', status: 'ok', owed: true }, 'npm-test': { id: 'npm-test', status: 'ok', owed: true }, 'retained-quality': { id: 'retained-quality', status: 'ok', owed: true } },
    failed_stage_reasons: [],
  };
  writeFileSync(join(targetDir, 'sitting.json'), JSON.stringify(sitting));
  writeFileSync(join(targetDir, 'retained-quality.json'), JSON.stringify(retained));
  return { root, reportsDir, sittingsDir, sourceDir, targetDir, retained, artifacts };
}

describe('retained quality report integration', () => {
  it('keeps valid retained revalidation independent of execution estimates', () => {
    const base = new Map([['quality-revalidation', ['report evaluator changed']]]);
    const evidence = { valid: true, status: 'revalidated' };
    assert.deepEqual([...resolveRetainedQualityRequirement(base, evidence)], [...base]);
    const invalid = resolveRetainedQualityRequirement(base, { valid: false, errors: ['missing raw output'] });
    assert.equal(invalid.has('quality-revalidation'), false);
    assert.equal(invalid.has('quality-baseline'), true);
    assert.equal(invalid.has('fever'), false);
  });

  it('schedules actual retained evaluation for report-only edits without fresh producer calls at unknown or large cost', async () => {
    for (const [path, estimatedMs] of [
      ['benchmark/report.ts', null],
      ['benchmark/lib/portable-quality.ts', 21 * 60_000],
    ] as const) {
      const f = await fixture();
      cpSync(join(packageRoot, 'benchmark', 'lib'), join(f.root, 'benchmark', 'lib'), { recursive: true });
      cpSync(join(packageRoot, 'benchmark', 'steps', 'retained-quality.ts'), join(f.root, 'benchmark', 'steps', 'retained-quality.ts'));
      symlinkSync(join(packageRoot, 'node_modules'), join(f.root, 'node_modules'), 'junction');
      cpSync(join(packageRoot, 'benchmark', 'report.ts'), join(f.root, 'benchmark', 'report.ts'));
      writeFileSync(join(f.root, path), `${readFileSync(join(f.root, path), 'utf8')}\n// evaluator wording changed\n`);
      const sittingsDir = join(f.root, '.tmp', 'sittings');
      const sourceDir = join(sittingsDir, (f.retained.source as { sitting: unknown }).sitting as string);
      const targetDir = join(sittingsDir, '2099-01-02-target');
      cpSync(f.sourceDir, sourceDir, { recursive: true });
      cpSync(f.targetDir, targetDir, { recursive: true });
      const sittingPath = join(targetDir, 'sitting.json');
      const sitting = JSON.parse(readFileSync(sittingPath, 'utf8'));
      const evidence = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root });
      assert.equal(evidence.valid, true, evidence.errors.join('\n'));
      const reasons = resolveRetainedQualityRequirement(profileReasons([path], 'v0.24.1', 'ordinary'), evidence);
      sitting.changed_paths = [path];
      sitting.owed = Object.fromEntries(reasons);
      sitting.effective_requirements = sitting.owed;
      // The fixture supplies completed static/functional proof; the pending evaluator must run.
      delete sitting.steps['retained-quality'];
      const stages = buildStages();
      const selected = stages.flatMap((stage) => stage.steps as StageStep[]).filter((step) => step.owedBy === 'always' || reasons.has(step.owedBy));
      sitting.estimated_cost = remainingCost(selected, { 'retained-quality': estimatedMs }, (step: { id: string }) => doneOnResume(step.id, sitting.steps[step.id]));
      assert.equal(sitting.estimated_cost.known_ms, estimatedMs ?? 0);
      assert.deepEqual(sitting.estimated_cost.unknown_steps, estimatedMs === null ? ['retained-quality'] : []);
      const executed: string[] = [];
      for (const stage of stages) {
        await runStageSteps(stage.steps, {
          collectIndependent: true,
          isOwed: (step: StageStep) => step.owedBy === 'always' || reasons.has(step.owedBy),
          resume: (step: StageStep) => (doneOnResume(step.id, sitting.steps[step.id]) ? sitting.steps[step.id] : null),
          run: (step: StageStep) => {
            executed.push(step.id);
            assert.equal(step.id, 'retained-quality', 'report/evaluator work must not call a fresh producer');
            const out = join(targetDir, `${step.id}.json`);
            const child = spawnSync(process.execPath, [...step.argv.slice(1), '--out', out], { cwd: f.root, encoding: 'utf8', timeout: 20_000 });
            assert.equal(child.error, undefined, child.stderr);
            assert.equal(child.status, 0, child.stderr || child.stdout);
            return { status: 'ok' };
          },
          recordNotOwed: (step: StageStep) => {
            sitting.steps[step.id] = { id: step.id, status: 'not-owed', owed: false };
          },
          recordResume: () => {},
          recordResult: (step: StageStep, result: { status: string }) => {
            sitting.steps[step.id] = { id: step.id, status: result.status, owed: true };
            return result.status;
          },
        });
      }
      assert.deepEqual(executed, ['retained-quality']);
      writeFileSync(sittingPath, JSON.stringify(sitting));
      const report = buildReport(targetDir, { reportsDir: f.reportsDir, sittingsDir, currentRoot: f.root });
      assert.equal(report.verdict, 'PASS', report.verdict_reasons.join('\n'));
      assert.equal(((report.retained_quality as { source: unknown }).source as { sitting: unknown }).sitting, (f.retained.source as { sitting: unknown }).sitting);
      const markdown = renderMarkdown(report);
      assert.match(markdown, /retained measurements: package 0\.24\.1, nfcorpus\/bare-and, split test, k=10, on sqlite, duckdb, turso/);
      assert.match(markdown, /Quality metrics were recomputed from the original rankings; this retained-quality step did not rerun search or measure timing/);
      unlinkSync(join(sourceDir, 'portable-eval-nfcorpus-sqlite.json'));
      const missing = buildReport(targetDir, { reportsDir: f.reportsDir, sittingsDir, currentRoot: f.root });
      assert.equal(missing.verdict, 'BLOCK');
      assert.equal((missing.retained_quality as { valid: unknown }).valid, false);
    }
  });

  it('revalidates NFCorpus from a historical superset after FEVER raw evidence is removed', async () => {
    const f = await fixture();
    for (const id of ['eval-fever', ...PORTABLE_QUALITY_STORES.map((store) => `portable-eval-fever-${store}`)]) unlinkSync(join(f.sourceDir, `${id}.json`));

    const checked = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root, expectedSource: f.retained.source });
    assert.equal(checked.valid, true, checked.errors.join('\n'));
    assert.ok(checked.artifacts);
    assert.deepEqual(Object.keys(checked.artifacts).sort(), [...retainedQualityIds].sort());
    const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(report.verdict, 'PASS', report.verdict_reasons.join('\n'));
    assert.deepEqual(
      Object.keys(report.steps)
        .filter((id) => id.startsWith('portable-eval-'))
        .sort(),
      [...retainedQualityIds].sort()
    );
    assert.equal(
      Object.keys(report.steps).some((id) => id.includes('fever')),
      false
    );
  });

  it('persists, resumes, and follows the original raw source through another revalidation', async () => {
    const f = await fixture();
    const first = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(first.verdict, 'PASS', first.verdict_reasons.join('\n'));
    assert.equal(first.profile, 'ordinary');
    const retainedSteps = first.steps as Record<string, QualityArtifact>;
    assert.deepEqual((first.retained_quality as { scope: unknown }).scope, RETAINED_QUALITY_SCOPE);
    assert.deepEqual(
      Object.keys(retainedSteps)
        .filter((id) => id.startsWith('portable-eval-'))
        .sort(),
      [...retainedQualityIds].sort()
    );
    assert.deepEqual(Object.keys((first.retained_quality as { raw_evidence: object }).raw_evidence).sort(), [...retainedQualityProducerIds].sort());
    assert.deepEqual(Object.keys((first.retained_quality as { source_steps_status: object }).source_steps_status).sort(), [...retainedQualityProducerIds].sort());
    assert.equal(retainedSteps['eval-fever'], undefined);
    assert.ok(first.assessment.verified_artifacts.includes('retained-quality'));
    persist(first, { sittingDir: f.targetDir, reportsDir: f.reportsDir, benchmarkingMdPath: join(f.root, 'BENCHMARKING.md') });
    const resumedSitting = JSON.parse(readFileSync(join(f.targetDir, 'sitting.json'), 'utf8'));
    const retainedStep = buildStages()
      .flatMap((stage) => stage.steps as StageStep[])
      .find((step) => step.id === 'retained-quality');
    assert.ok(retainedStep);
    let executed = false;
    const scheduled = await runStageSteps([retainedStep], {
      isOwed: () => true,
      resume: () => (doneOnResume('retained-quality', resumedSitting.steps['retained-quality']) ? resumedSitting.steps['retained-quality'] : null),
      run: async () => {
        executed = true;
        return { status: 'ok' };
      },
      recordNotOwed: () => {},
      recordResume: (_step: StageStep, recorded: Record<string, unknown>) => {
        resumedSitting.steps['retained-quality'] = { ...recorded, resumed: true };
      },
      recordResult: () => 'ok',
    });
    assert.equal(scheduled.failed, false);
    assert.equal(executed, false);
    writeFileSync(join(f.targetDir, 'sitting.json'), JSON.stringify(resumedSitting));
    const resumed = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(resumed.verdict, 'PASS');
    assert.equal(((resumed.retained_quality as { source: unknown }).source as { sitting: unknown }).sitting, (f.retained.source as { sitting: unknown }).sitting);

    const promoted = compactReleaseRecord({ ...resumed, release_version: PACKAGE_VERSION });
    assert.equal((promoted.retained_quality as { source_compact: unknown }).source_compact, undefined);
    assert.ok((promoted.retained_quality as { source_compact_hashes: Record<string, unknown> }).source_compact_hashes['portable-eval-nfcorpus-sqlite']);
    assert.equal((promoted.steps['retained-quality'] as { source_compact: unknown }).source_compact, undefined);
    assert.equal((promoted.steps['retained-quality'] as { artifacts: unknown }).artifacts, undefined);
    writeFileSync(join(f.reportsDir, `2099-01-02-${PACKAGE_VERSION}-release-gate.json`), JSON.stringify(promoted));
    unlinkSync(join(f.sourceDir, 'release-gate.json'));
    const second = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root });
    assert.equal(second.valid, true, second.errors.join('\n'));
    assert.deepEqual(second.source, f.retained.source);

    const rawPath = join(f.sourceDir, 'portable-eval-nfcorpus-sqlite.json');
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    raw.variants.semantic.per_query.q1.paths = [];
    writeFileSync(rawPath, JSON.stringify(raw));
    const changed = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root });
    assert.equal(changed.valid, false);
    assert.ok(changed.errors.some((error) => /recorded identity/.test(error)));
  });

  it('stores one copy of a retained payload in a compact report', () => {
    const payload = 'unique retained payload marker';
    const source = { kind: 'sitting', report: 'release-gate.json', sitting: '2099-01-01-source', package_version: PACKAGE_VERSION };
    const sourceCompact = { 'portable-eval-nfcorpus-sqlite': { marker: payload } };
    const artifacts = { 'portable-eval-nfcorpus-sqlite': { marker: payload } };
    const retained = { schema: RETAINED_QUALITY_SCHEMA, scope: RETAINED_QUALITY_SCOPE, valid: true, status: 'revalidated', source, source_compact: sourceCompact, artifacts };
    const report = { sitting: '2099-01-02-target', retained_quality: retained, steps: { 'retained-quality': retained, 'portable-eval-nfcorpus-sqlite': { marker: payload } } };
    const compact = compactReleaseRecord(report);
    const serialized = JSON.stringify(compact);
    assert.equal(serialized.split(payload).length - 1, 1);
    assert.deepEqual((compact.retained_quality as { source: unknown }).source, source);
    assert.equal((compact.retained_quality as { source_compact: unknown }).source_compact, undefined);
    assert.equal((compact.retained_quality as { source_compact_hashes: Record<string, unknown> }).source_compact_hashes['portable-eval-nfcorpus-sqlite'], identityHash(sourceCompact['portable-eval-nfcorpus-sqlite']));
    assert.equal((compact.steps['retained-quality'] as { artifacts: unknown }).artifacts, undefined);
    assert.equal((compact.steps['retained-quality'] as { artifact_hashes: Record<string, unknown> }).artifact_hashes['portable-eval-nfcorpus-sqlite'], identityHash(artifacts['portable-eval-nfcorpus-sqlite']));
  });

  it('fails closed after scope, workload, raw, summary, input-coverage, producer-completion, or artifact-file tampering', async () => {
    for (const kind of ['scope', 'workload', 'raw', 'summary', 'inputs', 'producer', 'malformed', 'missing-raw', 'missing'] as const) {
      const f = await fixture();
      if (kind === 'raw' || kind === 'workload') {
        const path = join(f.sourceDir, 'portable-eval-nfcorpus-sqlite.json');
        const artifact = JSON.parse(readFileSync(path, 'utf8'));
        if (kind === 'raw') artifact.variants.semantic.per_query.q1.paths = [];
        if (kind === 'workload') artifact.corpus = 'fever';
        writeFileSync(path, JSON.stringify(artifact));
      } else if (kind === 'missing-raw') {
        unlinkSync(join(f.sourceDir, 'portable-eval-nfcorpus-sqlite.json'));
      } else if (kind === 'missing') {
        unlinkSync(join(f.targetDir, 'retained-quality.json'));
      } else if (kind === 'malformed') {
        writeFileSync(join(f.targetDir, 'retained-quality.json'), '{');
      } else {
        const path = join(f.targetDir, 'retained-quality.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (kind === 'scope') record.scope.stores = ['sqlite'];
        if (kind === 'summary') record.artifacts['portable-eval-nfcorpus-sqlite'].variants.semantic.ndcg = 0;
        if (kind === 'inputs') delete record.current_inputs['portable-eval-nfcorpus-sqlite'];
        if (kind === 'producer') record.source_steps_status['portable-eval-nfcorpus-sqlite'].status = 'failed';
        writeFileSync(path, JSON.stringify(record));
      }
      const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
      assert.equal(report.verdict, 'BLOCK', kind);
      assert.notEqual((report.retained_quality as { valid?: unknown } | null | undefined)?.valid, true, kind);
      const validity = report.classifications.find((row) => row.id === 'retained-quality/validity' && 'invalid' in row && row.invalid);
      assert.ok(validity, kind);
      if (kind === 'workload') assert.match(validity.reason as string, /full nfcorpus gate workload/);
    }
  });

  it('refuses retained evidence after current retrieval, model, corpus, label, or query-set changes', async () => {
    for (const kind of ['retrieval', 'model', 'corpus', 'labels', 'new-query'] as const) {
      const f = await fixture();
      if (kind === 'retrieval') writeFileSync(join(f.root, 'src/output/search-error.ts'), `${readFileSync(join(f.root, 'src/output/search-error.ts'), 'utf8')}\n// changed\n`);
      if (kind === 'model') writeFileSync(join(f.root, 'model/model.safetensors'), 'changed weights');
      if (kind === 'corpus') writeFileSync(join(f.root, '.tmp/cache/nfcorpus-beir-1/tree/doc.md'), 'changed alpha\n');
      if (kind === 'labels') writeFileSync(join(f.root, '.tmp/cache/nfcorpus-beir-1/labels/queries.jsonl'), '{"_id":"q1","text":"changed alpha"}\n');
      if (kind === 'new-query') {
        writeFileSync(join(f.root, '.tmp/cache/nfcorpus-beir-1/labels/queries.jsonl'), '{"_id":"q1","text":"alpha"}\n{"_id":"q2","text":"beta"}\n');
        writeFileSync(join(f.root, '.tmp/cache/nfcorpus-beir-1/labels/test.tsv'), 'query-id\tcorpus-id\tscore\nq1\tdoc\t1\nq2\tdoc\t1\n');
      }
      const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
      assert.equal(report.verdict, 'BLOCK', kind);
      const checked = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root, expectedSource: f.retained.source });
      assert.equal(checked.valid, false, kind);
      const selected = resolveRetainedQualityRequirement(profileReasons(['src/output/output.ts'], 'v0.24.1', 'ordinary'), checked);
      assert.equal(selected.has('quality-revalidation'), false, kind);
      assert.equal(selected.has('quality-baseline'), true, kind);
      assert.equal(selected.has('fever'), false, kind);
    }
  });

  it('expands a resume from invalid retained evidence to fresh quality without rerunning completed work', async () => {
    const f = await fixture();
    const rawPath = join(f.sourceDir, 'portable-eval-nfcorpus-sqlite.json');
    const tampered = JSON.parse(readFileSync(rawPath, 'utf8'));
    tampered.variants.semantic.per_query.q1.paths = [];
    writeFileSync(rawPath, JSON.stringify(tampered));
    const unavailable = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root, expectedSource: f.retained.source });
    const reasons = resolveRetainedQualityRequirement(new Map([['quality-revalidation', ['ordinary baseline requires a current quality view']]]), unavailable);
    const sittingPath = join(f.targetDir, 'sitting.json');
    const sitting = JSON.parse(readFileSync(sittingPath, 'utf8'));
    assert.doesNotThrow(() => assertCompatibleSelection(sitting, { lastTag: 'v0.24.1', paths: ['src/output/output.ts'], reasons, profile: 'ordinary', retainedQuality: unavailable }));
    sitting.owed = Object.fromEntries(reasons);
    sitting.effective_requirements = sitting.owed;
    sitting.retained_quality = retainedQualityForSitting(sitting.retained_quality, unavailable, reasons);
    assert.equal(sitting.retained_quality.status, 'superseded-by-fresh-quality');
    assert.equal(sitting.retained_quality.source.sitting, (f.retained.source as { sitting: unknown }).sitting);
    assert.match(sitting.retained_quality.reason, /retained|artifact|evidence/i);
    const qualitySteps = (buildStages().find((stage) => stage.id === 'quality')?.steps ?? []) as StageStep[];
    const executed: string[] = [];
    const scheduled = await runStageSteps(qualitySteps, {
      collectIndependent: true,
      isOwed: (step: StageStep) => step.owedBy === 'quality-baseline',
      resume: () => null,
      run: async (step: StageStep) => {
        executed.push(step.id);
        let artifact: unknown = f.artifacts[step.id];
        if (step.id.endsWith('-comparison')) {
          artifact = comparePortableQualityArtifacts(PORTABLE_QUALITY_STORES.map((store) => f.artifacts[`portable-eval-nfcorpus-${store}`]));
        }
        writeFileSync(join(f.targetDir, `${step.id}.json`), JSON.stringify(artifact));
        return { status: 'ok' };
      },
      recordNotOwed: (step: StageStep) => {
        sitting.steps[step.id] = { id: step.id, status: 'not-owed', owed: false };
      },
      recordResume: () => assert.fail('fresh quality must not resume from retained evidence'),
      recordResult: (step: StageStep) => {
        sitting.steps[step.id] = { id: step.id, status: 'ok', owed: true };
        return 'ok';
      },
    });
    assert.equal(scheduled.failed, false);
    assert.equal(executed.includes('retained-quality'), false);
    assert.deepEqual(executed, [...PORTABLE_QUALITY_STORES.map((store) => `portable-eval-nfcorpus-${store}`), 'portable-eval-nfcorpus-comparison']);
    assert.equal(executed.includes('eval-nfcorpus'), false);
    assert.equal(executed.includes('eval-fever'), false);
    assert.equal(sitting.steps.validate.status, 'ok');
    assert.equal(sitting.steps['npm-test'].status, 'ok');
    sitting.failed_stage_reasons = [];
    writeFileSync(sittingPath, JSON.stringify(sitting));
    const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(report.verdict, 'PASS', report.verdict_reasons.join('\n'));
    assert.equal((report.retained_quality as { status: unknown }).status, 'superseded-by-fresh-quality');
    assert.equal(((report.retained_quality as { source: unknown }).source as { sitting: unknown }).sitting, (f.retained.source as { sitting: unknown }).sitting);
  });

  it('treats a missing cache as unavailable without creating it', async () => {
    const f = await fixture();
    const emptyRoot = currentRoot(false);
    const missing = join(emptyRoot, '.tmp', 'cache', 'nfcorpus-beir-1');
    const result = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: emptyRoot, expectedSource: f.retained.source });
    assert.equal(result.valid, false);
    assert.equal(cachedCorpusPaths('nfcorpus', join(emptyRoot, '.tmp', 'cache')).tree, null);
    assert.equal(existsSync(missing), false);
  });
});
