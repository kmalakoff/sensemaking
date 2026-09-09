import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES } from '../../benchmark/lib/portable-quality.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { aggregateVerdict } from '../../benchmark/lib/verdict.mjs';
import { logicalWorkloadIdentity } from '../../benchmark/lib/workload-identity.mjs';
import { buildReport, renderMarkdown } from '../../benchmark/report.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

const STORES = PORTABLE_QUALITY_STORES;
type PersistedQualityResult = { paths: unknown[]; ndcg: number; rr: number; hit: number };
type PersistedQualityVariant = { ndcg: number; rr: number; hit: number; per_query: Record<string, PersistedQualityResult> };

function artifact(store: string, overrides: Record<string, unknown> = {}) {
  const corpus = typeof overrides.corpus === 'string' ? overrides.corpus : 'fixture';
  const queryEvidence = { q1: { text: 'alpha beta', canonical: 'alpha beta' }, q2: { text: 'gamma delta', canonical: 'gamma delta' } };
  const qrels = { q1: { alpha: 1 }, q2: { gamma: 1 } };
  const variants = Object.fromEntries(
    ['bm25-only', 'fused', 'semantic'].map((name) => [
      name,
      {
        workload_identity: logicalWorkloadIdentity({ corpus: { fingerprint: corpus }, operation: { kind: 'quality', corpus, split: 'test', k: 2, query_form: 'bare-and', query_evidence: queryEvidence, qrels }, requested: { variant: name, config: { signals: { words: 1 } }, model: { status: 'not-applicable' } } }),
        execution: { config: { signals: { words: 1 } } },
        errors: 0,
        incomplete: false,
        ndcg: 1,
        rr: 1,
        hit: 1,
        per_query: { q1: { ndcg: 1, rr: 1, hit: 1, paths: ['alpha.md'] }, q2: { ndcg: 1, rr: 1, hit: 1, paths: ['gamma.md'] } },
      },
    ])
  );
  return { corpus, split: 'test', queries: 2, k: 2, store, measure_version: MEASURE_VERSION, query_form: 'bare-and', query_evidence: queryEvidence, qrels, variants, ...overrides };
}

function authoredFractionArtifact(store: string, reverseKeys = false) {
  const rows = [
    ['q1', 3, 0.5, 1 / 3],
    ['q2', 4, 0.43067655807339306, 0.25],
    ['q3', 5, 0.38685280723454163, 0.2],
    ['q4', 6, 0.3562071871080222, 1 / 6],
    ['q5', 7, 1 / 3, 1 / 7],
    ['q6', 8, 0.31546487678572877, 0.125],
    ['q7', 9, 0.3010299956639812, 1 / 9],
  ] as const;
  const ordered = reverseKeys ? [...rows].reverse() : rows;
  const queryEvidence = Object.fromEntries(ordered.map(([qid]) => [qid, { text: `query ${qid}`, canonical: `query ${qid}` }]));
  const qrels = Object.fromEntries(ordered.map(([qid]) => [qid, { [`relevant-${qid}`]: 1 }]));
  const perQuery = Object.fromEntries(ordered.map(([qid, rank, ndcg, rr]) => [qid, { ndcg, rr, hit: 1, paths: [...Array.from({ length: rank - 1 }, (_, index) => `miss-${qid}-${index}.md`), `relevant-${qid}.md`] }]));
  const operation = { kind: 'quality', corpus: 'authored-fractions', split: 'test', k: 10, query_form: 'bare-and', query_evidence: queryEvidence, qrels };
  const variants = Object.fromEntries(
    ['bm25-only', 'fused', 'semantic'].map((name) => [
      name,
      {
        workload_identity: logicalWorkloadIdentity({ corpus: { fingerprint: 'authored-fractions' }, operation, requested: { variant: name, config: { signals: { words: 1 } }, model: { status: 'not-applicable' } } }),
        execution: { config: { signals: { words: 1 } } },
        errors: 0,
        incomplete: false,
        ndcg: 0.3747949654570001,
        rr: 0.18985260770975057,
        hit: 1,
        per_query: perQuery,
      },
    ])
  );
  return { corpus: 'authored-fractions', split: 'test', queries: 7, k: 10, store, measure_version: MEASURE_VERSION, query_form: 'bare-and', query_evidence: queryEvidence, qrels, variants };
}

describe('portable quality release track', () => {
  it('uses sorted query IDs and sum-then-divide means for authored fractional metrics', () => {
    const artifacts = STORES.map((store, index) => authoredFractionArtifact(store, index % 2 === 1));
    const valid = comparePortableQualityArtifacts(artifacts);
    assert.equal(valid.valid, true, valid.errors.join('; '));

    const tamperedMetric = authoredFractionArtifact('sqlite');
    tamperedMetric.variants.semantic.per_query.q4.rr = 0.5;
    const metricResult = comparePortableQualityArtifacts([tamperedMetric, authoredFractionArtifact('duckdb', true), authoredFractionArtifact('turso')]);
    assert.equal(metricResult.valid, false);
    assert.match(metricResult.errors.join('\n'), /semantic\/q4: recorded rr .* does not match recomputed/);
    assert.equal(metricResult.measure_version, MEASURE_VERSION);

    const missingCoverage = authoredFractionArtifact('sqlite');
    delete missingCoverage.variants.semantic.per_query.q4;
    const coverageResult = comparePortableQualityArtifacts([missingCoverage, authoredFractionArtifact('duckdb', true), authoredFractionArtifact('turso')]);
    assert.equal(coverageResult.valid, false);
    assert.match(coverageResult.errors.join('\n'), /semantic: per_query coverage differs from qrels/);
    assert.equal(coverageResult.measure_version, MEASURE_VERSION);
  });

  it('requires the same stores, query form, qrels, k, and complete per-query coverage', () => {
    const valid = comparePortableQualityArtifacts(STORES.map((store) => artifact(store)));
    assert.equal(valid.valid, true, valid.errors.join('; '));
    const changed = comparePortableQualityArtifacts(STORES.map((store) => artifact(store, store === 'turso' ? { qrels: { q1: { other: 1 }, q2: { gamma: 1 } } } : {})));
    assert.equal(changed.valid, false);
    assert.match(changed.errors.join('\n'), /workload differs|does not match recorded query\/corpus evidence/);
    const incomplete = comparePortableQualityArtifacts(STORES.map((store) => artifact(store, store === 'duckdb' ? { variants: { ...artifact(store).variants, semantic: { ...artifact(store).variants.semantic, per_query: { q1: artifact(store).variants.semantic.per_query.q1 } } } } : {})));
    assert.equal(incomplete.valid, false);
    assert.match(incomplete.errors.join('\n'), /semantic: per_query coverage differs/);
    const modelDrift = artifact('turso');
    modelDrift.variants.semantic.workload_identity = logicalWorkloadIdentity({
      corpus: { fingerprint: 'fixture' },
      operation: { corpus: 'fixture', split: 'test', k: 2, query_form: 'bare-and', query_evidence: modelDrift.query_evidence, qrels: modelDrift.qrels },
      requested: { variant: 'semantic', config: { signals: { words: 1 } }, model: { provider: 'static', model: 'different-model', reuse_eligible: true } },
    });
    const drift = comparePortableQualityArtifacts([artifact('sqlite'), artifact('duckdb'), modelDrift]);
    assert.equal(drift.valid, false);
    assert.match(drift.errors.join('\n'), /semantic: workload identity differs|does not match recorded query\/corpus evidence/);
    const malformed = artifact('duckdb');
    Object.assign(malformed.variants.fused, { workload_identity: {} });
    const malformedResult = comparePortableQualityArtifacts([artifact('sqlite'), malformed, artifact('turso')]);
    assert.equal(malformedResult.valid, false);
    assert.match(malformedResult.errors.join('\n'), /fused: workload identity is missing or invalid/);
    const missingQuery = artifact('duckdb', { query_evidence: { q1: { text: '', canonical: '' }, q2: artifact('duckdb').query_evidence.q2 } });
    const missingQueryResult = comparePortableQualityArtifacts([artifact('sqlite'), missingQuery, artifact('turso')]);
    assert.equal(missingQueryResult.valid, false);
    assert.match(missingQueryResult.errors.join('\n'), /q1: query evidence is incomplete/);
  });

  it('recomputes persisted rankings and metrics while preserving valid empty rankings', () => {
    const empty = comparePortableQualityArtifacts(
      STORES.map((store) => {
        const current = artifact(store);
        for (const variant of Object.values(current.variants) as PersistedQualityVariant[]) {
          variant.ndcg = 0;
          variant.rr = 0;
          variant.hit = 0;
          for (const result of Object.values(variant.per_query)) {
            result.paths = [];
            result.ndcg = 0;
            result.rr = 0;
            result.hit = 0;
          }
        }
        return current;
      })
    );
    assert.equal(empty.valid, true, empty.errors.join('; '));

    const invalidCases: Array<[string, (current: ReturnType<typeof artifact>) => void, RegExp]> = [
      [
        'empty result ID',
        (current) => {
          current.variants.semantic.per_query.q1.paths = [''];
        },
        /empty or non-string id/,
      ],
      [
        'non-string result ID',
        (current) => {
          current.variants.semantic.per_query.q1.paths = [42] as unknown as string[];
        },
        /empty or non-string id/,
      ],
      [
        'duplicate result ID',
        (current) => {
          current.variants.semantic.per_query.q1.paths = ['alpha.md', 'alpha'];
        },
        /duplicate id/,
      ],
      [
        'more than k results',
        (current) => {
          current.variants.semantic.per_query.q1.paths = ['alpha.md', 'gamma.md', 'third.md'];
        },
        /more than k/,
      ],
      [
        'invalid relevance grade',
        (current) => {
          current.qrels.q1.alpha = -1;
        },
        /malformed grade/,
      ],
      [
        'inconsistent per-query metric',
        (current) => {
          current.variants.semantic.per_query.q1.ndcg = 0.5;
        },
        /does not match recomputed/,
      ],
      [
        'inconsistent aggregate metric',
        (current) => {
          current.variants.semantic.ndcg = 0.5;
        },
        /aggregate ndcg .* does not match recomputed/,
      ],
      [
        'unjudged query',
        (current) => {
          (current.qrels as Record<string, Record<string, number>>).q1 = {};
        },
        /qrels contain no judged documents/,
      ],
    ];
    for (const [label, mutate, expected] of invalidCases) {
      const current = artifact('sqlite');
      mutate(current);
      const result = comparePortableQualityArtifacts([current, artifact('duckdb'), artifact('turso')]);
      assert.equal(result.valid, false, `${label} must invalidate the comparison`);
      assert.match(result.errors.join('\n'), expected, label);
    }
  });

  it('binds identities to recorded query, corpus, and configuration evidence', () => {
    const cases: Array<[string, (current: ReturnType<typeof artifact>) => void, RegExp]> = [
      [
        'changed query evidence',
        (current) => {
          current.query_evidence.q1.text = 'different query';
        },
        /recorded query\/corpus evidence/,
      ],
      [
        'changed corpus evidence',
        (current) => {
          current.corpus = 'different-corpus';
        },
        /recorded query\/corpus evidence/,
      ],
      [
        'changed configuration evidence',
        (current) => {
          current.variants.semantic.execution.config.signals.words = 2;
        },
        /recorded configuration/,
      ],
      [
        'changed identity fingerprint',
        (current) => {
          current.variants.semantic.workload_identity.fingerprint = 'changed';
        },
        /workload identity is missing or invalid/,
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const current = artifact('sqlite');
      mutate(current);
      const result = comparePortableQualityArtifacts([current, artifact('duckdb'), artifact('turso')]);
      assert.equal(result.valid, false, `${label} must invalidate the comparison`);
      assert.match(result.errors.join('\n'), expected, label);
    }
  });

  it('rejects missing stores, variants, queries, and retrieval-error artifacts', () => {
    const missingStore = comparePortableQualityArtifacts([artifact('sqlite'), artifact('duckdb')]);
    assert.equal(missingStore.valid, false);
    assert.match(missingStore.errors.join('\n'), /turso: artifact is missing/);

    const missingVariant = artifact('duckdb');
    delete missingVariant.variants.semantic;
    const missingVariantResult = comparePortableQualityArtifacts([artifact('sqlite'), missingVariant, artifact('turso')]);
    assert.equal(missingVariantResult.valid, false);
    assert.match(missingVariantResult.errors.join('\n'), /variants must be .*semantic|semantic: variant is missing/);

    const missingQuery = artifact('duckdb');
    delete (missingQuery.query_evidence as Record<string, unknown>).q2;
    const missingQueryResult = comparePortableQualityArtifacts([artifact('sqlite'), missingQuery, artifact('turso')]);
    assert.equal(missingQueryResult.valid, false);
    assert.match(missingQueryResult.errors.join('\n'), /query evidence and qrels do not cover the same query IDs/);

    const retrievalError = artifact('duckdb');
    retrievalError.variants.semantic.errors = 1;
    (retrievalError.variants.semantic as typeof retrievalError.variants.semantic & { error_details: Array<{ qid: string; error: string }> }).error_details = [{ qid: 'q2', error: 'database unavailable' }];
    const retrievalErrorResult = comparePortableQualityArtifacts([artifact('sqlite'), retrievalError, artifact('turso')]);
    assert.equal(retrievalErrorResult.valid, false);
    assert.match(retrievalErrorResult.errors.join('\n'), /semantic: retrieval is incomplete/);
  });

  it('discovers sibling artifacts from the output path in the real comparator CLI', () => {
    const dir = scratchDir('portable-quality-comparator-cli');
    for (const store of STORES) writeFileSync(join(dir, `portable-quality-${store}.json`), JSON.stringify(artifact(store)));
    const out = join(dir, 'portable-quality-comparison.json');
    const result = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/portable-quality-compare.mjs'), '--out', out], { cwd: packageRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).valid, true);
    assert.equal(existsSync(join(dir, 'portable-quality-comparison.json')), true);
  });

  it('keeps the historical commands and finishes the smaller corpus before FEVER', () => {
    const quality = buildStages().find((stage) => stage.id === 'quality');
    assert.ok(quality);
    assert.deepEqual(
      quality.steps.map((step) => step.id),
      ['eval-nfcorpus', ...STORES.map((store) => `portable-eval-nfcorpus-${store}`), 'portable-eval-nfcorpus-comparison', 'eval-fever', ...STORES.map((store) => `portable-eval-fever-${store}`), 'portable-eval-fever-comparison']
    );
    assert.deepEqual(quality.steps.find((step) => step.id === 'eval-nfcorpus')?.argv, ['node', 'benchmark/steps/quality.mjs', 'nfcorpus']);
    assert.deepEqual(quality.steps.find((step) => step.id === 'eval-fever')?.argv, ['node', 'benchmark/steps/quality.mjs', 'fever']);
    assert.deepEqual(
      quality.steps.filter((step) => step.id.startsWith('portable-eval-')).map((step) => step.id),
      [...['nfcorpus', 'fever'].flatMap((corpus) => [...STORES.map((store) => `portable-eval-${corpus}-${store}`), `portable-eval-${corpus}-comparison`])]
    );
    const portable = quality.steps.find((step) => step.id === 'portable-eval-nfcorpus-duckdb');
    assert.deepEqual(portable?.argv, ['node', 'benchmark/steps/quality.mjs', 'nfcorpus', '--store', 'duckdb', '--query-form', 'bare-and']);
  });

  it('keeps portable relevance and timing movements visible without blocking', () => {
    const result = aggregateVerdict(
      [
        { id: 'portable-eval-nfcorpus-sqlite/semantic/ndcg', context: 'portable-eval-nfcorpus-sqlite/semantic', key: 'ndcg', comparison_class: 'quality', verdict: 'fell', reason: 'quality fell' },
        { id: 'stress/map_ms', context: 'stress', key: 'map_ms', verdict: 'moved', reason: 'timing moved' },
      ],
      []
    );
    assert.deepEqual(result, { verdict: 'PASS', reasons: [] });
  });

  it('shows a new portable workload as no-compatible-prior while invalid retrieval blocks', () => {
    const sitting = scratchDir('portable-quality-new-workload');
    const steps: Record<string, { status: string }> = {};
    for (const corpus of ['nfcorpus', 'fever']) {
      for (const store of STORES) {
        const id = `portable-eval-${corpus}-${store}`;
        steps[id] = { status: 'ok' };
        writeFileSync(join(sitting, `${id}.json`), JSON.stringify(artifact(store, { corpus })));
      }
      const comparison = comparePortableQualityArtifacts(STORES.map((store) => artifact(store, { corpus })));
      const comparisonId = `portable-eval-${corpus}-comparison`;
      steps[comparisonId] = { status: 'ok' };
      writeFileSync(join(sitting, `${comparisonId}.json`), JSON.stringify(comparison));
    }
    for (const id of ['validate', 'npm-test']) steps[id] = { status: 'ok' };
    for (const id of ['eval-nfcorpus', 'eval-fever']) {
      steps[id] = { status: 'ok' };
      writeFileSync(join(sitting, `${id}.json`), JSON.stringify(artifact('sqlite', { corpus: id })));
    }
    writeFileSync(
      join(sitting, 'sitting.json'),
      JSON.stringify({ date: '2099-01-01', baseline_version: '0.23.0', machine: {}, node: process.version, changed_paths: ['src/commands/search.ts'], owed: { 'quality-baseline': ['src/commands/search.ts'], fever: ['src/commands/search.ts'] }, steps, failed_stage_reasons: [] })
    );
    const report = buildReport(sitting, { reportsDir: scratchDir('portable-quality-no-prior-reports') });
    assert.equal(report.verdict, 'PASS', report.verdict_reasons.join('; '));
    const portable = report.classifications.filter((row) => row.id.startsWith('portable-eval-') && row.key === 'ndcg');
    assert.equal(portable.length, 18);
    assert.ok(portable.every((row) => row.verdict === 'no-compatible-prior'));

    const invalidSitting = scratchDir('portable-quality-invalid-current');
    writeFileSync(
      join(invalidSitting, 'sitting.json'),
      JSON.stringify({ date: '2099-01-01', baseline_version: '0.23.0', machine: {}, node: process.version, changed_paths: ['src/commands/search.ts'], owed: { 'quality-baseline': ['src/commands/search.ts'] }, steps: { 'portable-eval-nfcorpus-sqlite': { status: 'ok' } }, failed_stage_reasons: [] })
    );
    writeFileSync(join(invalidSitting, 'portable-eval-nfcorpus-sqlite.json'), JSON.stringify(artifact('sqlite', { error: 'retrieval failed', incomplete: true })));
    const invalid = buildReport(invalidSitting, { reportsDir: scratchDir('portable-quality-invalid-reports') });
    assert.equal(invalid.verdict, 'BLOCK');
    assert.ok(invalid.verdict_reasons.some((reason) => reason.includes('retrieval failed')));
  });

  it('blocks malformed persisted quality evidence through the final report and renderer', () => {
    const cases: Array<[string, (current: ReturnType<typeof artifact>) => void]> = [
      ['missing query', (current) => delete (current.variants.semantic.per_query as Record<string, PersistedQualityResult>).q2],
      ['missing variant', (current) => delete current.variants.semantic],
      [
        'retrieval error',
        (current) => {
          current.variants.semantic.errors = 1;
        },
      ],
      [
        'invalid label',
        (current) => {
          current.qrels.q1.alpha = -1;
        },
      ],
      [
        'duplicate paths',
        (current) => {
          current.variants.semantic.per_query.q1.paths = ['alpha.md', 'alpha'];
        },
      ],
      [
        'inconsistent metric',
        (current) => {
          current.variants.semantic.per_query.q1.ndcg = 0.5;
        },
      ],
      [
        'changed identity',
        (current) => {
          current.variants.semantic.workload_identity.fingerprint = 'changed';
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const sitting = scratchDir(`portable-quality-report-${label.replace(/\s+/g, '-')}`);
      const artifacts = STORES.map((store) => artifact(store, { corpus: 'nfcorpus' }));
      mutate(artifacts[0]);
      const steps: Record<string, { id: string; status: string; owed: boolean }> = {
        validate: { id: 'validate', status: 'ok', owed: true },
        'npm-test': { id: 'npm-test', status: 'ok', owed: true },
        'eval-nfcorpus': { id: 'eval-nfcorpus', status: 'ok', owed: true },
      };
      writeFileSync(join(sitting, 'eval-nfcorpus.json'), JSON.stringify(artifact('sqlite', { corpus: 'nfcorpus' })));
      for (const current of artifacts) {
        const id = `portable-eval-nfcorpus-${current.store}`;
        steps[id] = { id, status: 'ok', owed: true };
        writeFileSync(join(sitting, `${id}.json`), JSON.stringify(current));
      }
      const comparisonId = 'portable-eval-nfcorpus-comparison';
      const comparison = comparePortableQualityArtifacts(artifacts);
      steps[comparisonId] = { id: comparisonId, status: comparison.valid ? 'ok' : 'failed', owed: true };
      writeFileSync(join(sitting, `${comparisonId}.json`), JSON.stringify(comparison));
      writeFileSync(
        join(sitting, 'sitting.json'),
        JSON.stringify({ date: '2099-01-01', baseline_version: '0.23.0', machine: {}, node: process.version, changed_paths: ['src/commands/search.ts'], owed: { 'quality-baseline': ['src/commands/search.ts'] }, steps, failed_stage_reasons: comparison.valid ? [] : [`${comparisonId}: failed`] })
      );
      const report = buildReport(sitting, { reportsDir: scratchDir(`portable-quality-report-output-${label.replace(/\s+/g, '-')}`) });
      assert.equal(report.verdict, 'BLOCK', `${label} must block`);
      assert.match(report.verdict_reasons.join('\n'), /portable|quality|retrieval|identity|metric|qrels|variant|per_query/i, label);
      assert.match(renderMarkdown(report), /BLOCK/, label);
    }

    const emptySitting = scratchDir('portable-quality-report-empty');
    const emptyArtifacts = STORES.map((store) => {
      const current = artifact(store, { corpus: 'nfcorpus' });
      for (const variant of Object.values(current.variants) as PersistedQualityVariant[]) {
        variant.ndcg = 0;
        variant.rr = 0;
        variant.hit = 0;
        for (const result of Object.values(variant.per_query)) Object.assign(result, { paths: [], ndcg: 0, rr: 0, hit: 0 });
      }
      return current;
    });
    const steps: Record<string, { id: string; status: string; owed: boolean }> = {
      validate: { id: 'validate', status: 'ok', owed: true },
      'npm-test': { id: 'npm-test', status: 'ok', owed: true },
      'eval-nfcorpus': { id: 'eval-nfcorpus', status: 'ok', owed: true },
    };
    writeFileSync(join(emptySitting, 'eval-nfcorpus.json'), JSON.stringify(artifact('sqlite', { corpus: 'nfcorpus' })));
    for (const current of emptyArtifacts) {
      const id = `portable-eval-nfcorpus-${current.store}`;
      steps[id] = { id, status: 'ok', owed: true };
      writeFileSync(join(emptySitting, `${id}.json`), JSON.stringify(current));
    }
    const comparisonId = 'portable-eval-nfcorpus-comparison';
    steps[comparisonId] = { id: comparisonId, status: 'ok', owed: true };
    writeFileSync(join(emptySitting, `${comparisonId}.json`), JSON.stringify(comparePortableQualityArtifacts(emptyArtifacts)));
    writeFileSync(join(emptySitting, 'sitting.json'), JSON.stringify({ date: '2099-01-01', baseline_version: '0.23.0', machine: {}, node: process.version, changed_paths: ['src/commands/search.ts'], owed: { 'quality-baseline': ['src/commands/search.ts'] }, steps, failed_stage_reasons: [] }));
    const emptyReport = buildReport(emptySitting, { reportsDir: scratchDir('portable-quality-report-empty-output') });
    assert.equal(emptyReport.verdict, 'PASS', emptyReport.verdict_reasons.join('; '));
    assert.match(renderMarkdown(emptyReport), /PASS/);
  });
});
