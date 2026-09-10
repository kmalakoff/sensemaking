import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'assert';
import { cachedCorpusPaths } from '../../benchmark/lib/corpus.mjs';
import { runStageSteps } from '../../benchmark/lib/gate-runner.mjs';
import { assertCompatibleSelection, profileReasons, resolveRetainedQualityRequirement, retainedQualityForSitting } from '../../benchmark/lib/gates.mjs';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES } from '../../benchmark/lib/portable-quality.mjs';
import { qualityRetrievalIdentity } from '../../benchmark/lib/quality-retrieval-identity.mjs';
import { observeQualityModel } from '../../benchmark/lib/quality-work-tree.mjs';
import { inspectRetainedQuality, retainedQualityProducerIds } from '../../benchmark/lib/retained-quality.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { captureFileManifest } from '../../benchmark/lib/work-tree.mjs';
import { identityHash, logicalWorkloadIdentity, manifestIdentity } from '../../benchmark/lib/workload-identity.mjs';
import { buildReport, compactReleaseRecord, doneOnResume, persist } from '../../benchmark/report.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

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
  for (const path of ['src', 'dist', 'benchmark/steps/quality.mjs', 'benchmark/lib/corpus.mjs', 'benchmark/lib/labels.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs', 'package.json', 'package-lock.json']) {
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
  const stepsStatus = Object.fromEntries(retainedQualityProducerIds.map((id) => [id, { id, status: 'ok', owed: true }]));
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
    retained_quality: { schema: retained.schema, measure_version: retained.measure_version, valid: true, status: 'revalidated', source: retained.source },
    owed: requirements,
    steps: { validate: { id: 'validate', status: 'ok', owed: true }, 'npm-test': { id: 'npm-test', status: 'ok', owed: true }, 'retained-quality': { id: 'retained-quality', status: 'ok', owed: true } },
    failed_stage_reasons: [],
  };
  writeFileSync(join(targetDir, 'sitting.json'), JSON.stringify(sitting));
  writeFileSync(join(targetDir, 'retained-quality.json'), JSON.stringify(retained));
  return { root, reportsDir, sittingsDir, sourceDir, targetDir, retained, artifacts };
}

describe('retained quality report integration', () => {
  it('persists, resumes, and follows the original raw source through another revalidation', async () => {
    const f = await fixture();
    const first = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(first.verdict, 'PASS', first.verdict_reasons.join('\n'));
    assert.equal(first.profile, 'ordinary');
    const retainedSteps = first.steps as Record<string, QualityArtifact>;
    assert.equal(retainedSteps['eval-fever'].variants.semantic.ndcg, 1);
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
    assert.equal(resumed.retained_quality.source.sitting, f.retained.source.sitting);

    const promoted = compactReleaseRecord({ ...resumed, release_version: PACKAGE_VERSION });
    assert.equal(promoted.retained_quality.source_compact, undefined);
    assert.ok(promoted.retained_quality.source_compact_hashes['eval-nfcorpus']);
    assert.equal(promoted.steps['retained-quality'].source_compact, undefined);
    assert.equal(promoted.steps['retained-quality'].artifacts, undefined);
    writeFileSync(join(f.reportsDir, `2099-01-02-${PACKAGE_VERSION}-release-gate.json`), JSON.stringify(promoted));
    unlinkSync(join(f.sourceDir, 'release-gate.json'));
    const second = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root });
    assert.equal(second.valid, true, second.errors.join('\n'));
    assert.deepEqual(second.source, f.retained.source);

    const rawPath = join(f.sourceDir, 'eval-nfcorpus.json');
    const raw = JSON.parse(readFileSync(rawPath, 'utf8'));
    raw.variants.semantic.per_query.q1.paths = [];
    writeFileSync(rawPath, JSON.stringify(raw));
    const changed = await inspectRetainedQuality({ reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, baselineVersion: PACKAGE_VERSION, currentRoot: f.root });
    assert.equal(changed.valid, false);
    assert.ok(changed.errors.some((error) => /recorded identity/.test(error)));
  });

  it('stores one copy of a production-sized retained payload in a compact report', () => {
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const source = { kind: 'sitting', report: 'release-gate.json', sitting: '2099-01-01-source', package_version: PACKAGE_VERSION };
    const sourceCompact = { 'eval-nfcorpus': { marker: payload } };
    const artifacts = { 'eval-nfcorpus': { marker: payload } };
    const retained = { schema: 'retained-quality-v1', valid: true, status: 'revalidated', source, source_compact: sourceCompact, artifacts };
    const report = { sitting: '2099-01-02-target', retained_quality: retained, steps: { 'retained-quality': retained, 'eval-nfcorpus': { marker: payload } } };
    const compact = compactReleaseRecord(report);
    const serialized = JSON.stringify(compact);
    assert.ok(serialized.length < payload.length * 2, `${serialized.length} compact bytes retain duplicate payloads`);
    assert.equal(serialized.split(payload).length - 1, 1);
    assert.deepEqual(compact.retained_quality.source, source);
    assert.equal(compact.retained_quality.source_compact, undefined);
    assert.equal(compact.retained_quality.source_compact_hashes['eval-nfcorpus'], identityHash(sourceCompact['eval-nfcorpus']));
    assert.equal(compact.steps['retained-quality'].artifacts, undefined);
    assert.equal(compact.steps['retained-quality'].artifact_hashes['eval-nfcorpus'], identityHash(artifacts['eval-nfcorpus']));
  });

  it('fails closed after raw, summary, input-coverage, producer-completion, or artifact-file tampering', async () => {
    for (const kind of ['raw', 'summary', 'inputs', 'producer', 'malformed', 'missing'] as const) {
      const f = await fixture();
      if (kind === 'raw') {
        const path = join(f.sourceDir, 'eval-nfcorpus.json');
        const artifact = JSON.parse(readFileSync(path, 'utf8'));
        artifact.variants.semantic.per_query.q1.paths = [];
        writeFileSync(path, JSON.stringify(artifact));
      } else if (kind === 'missing') {
        unlinkSync(join(f.targetDir, 'retained-quality.json'));
      } else if (kind === 'malformed') {
        writeFileSync(join(f.targetDir, 'retained-quality.json'), '{');
      } else {
        const path = join(f.targetDir, 'retained-quality.json');
        const record = JSON.parse(readFileSync(path, 'utf8'));
        if (kind === 'summary') record.artifacts['eval-nfcorpus'].variants.semantic.ndcg = 0;
        if (kind === 'inputs') delete record.current_inputs['eval-nfcorpus'];
        if (kind === 'producer') record.source_steps_status['eval-nfcorpus'].status = 'failed';
        writeFileSync(path, JSON.stringify(record));
      }
      const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
      assert.equal(report.verdict, 'BLOCK', kind);
      assert.notEqual(report.retained_quality?.valid, true, kind);
      assert.ok(
        report.classifications.some((row) => row.id === 'retained-quality/validity' && 'invalid' in row && row.invalid),
        kind
      );
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
      assert.equal(selected.has('fever'), true, kind);
    }
  });

  it('expands a resume from invalid retained evidence to fresh quality without rerunning completed work', async () => {
    const f = await fixture();
    const rawPath = join(f.sourceDir, 'eval-nfcorpus.json');
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
    assert.equal(sitting.retained_quality.source.sitting, f.retained.source.sitting);
    assert.match(sitting.retained_quality.reason, /retained|artifact|evidence/i);
    const qualitySteps = (buildStages().find((stage) => stage.id === 'quality')?.steps ?? []) as StageStep[];
    const executed: string[] = [];
    const scheduled = await runStageSteps(qualitySteps, {
      collectIndependent: true,
      isOwed: (step: StageStep) => step.owedBy === 'quality-baseline' || step.owedBy === 'fever',
      resume: () => null,
      run: async (step: StageStep) => {
        executed.push(step.id);
        let artifact: unknown = f.artifacts[step.id];
        if (step.id.endsWith('-comparison')) {
          const corpus = step.id.includes('nfcorpus') ? 'nfcorpus' : 'fever';
          artifact = comparePortableQualityArtifacts(PORTABLE_QUALITY_STORES.map((store) => f.artifacts[`portable-eval-${corpus}-${store}`]));
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
    assert.equal(executed.includes('eval-nfcorpus'), true);
    assert.equal(executed.includes('eval-fever'), true);
    assert.equal(sitting.steps.validate.status, 'ok');
    assert.equal(sitting.steps['npm-test'].status, 'ok');
    sitting.failed_stage_reasons = [];
    writeFileSync(sittingPath, JSON.stringify(sitting));
    const report = buildReport(f.targetDir, { reportsDir: f.reportsDir, sittingsDir: f.sittingsDir, currentRoot: f.root });
    assert.equal(report.verdict, 'PASS', report.verdict_reasons.join('\n'));
    assert.equal(report.retained_quality.status, 'superseded-by-fresh-quality');
    assert.equal(report.retained_quality.source.sitting, f.retained.source.sitting);
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
