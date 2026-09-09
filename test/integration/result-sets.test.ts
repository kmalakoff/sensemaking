import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_NAMES } from 'sensemaking';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { pairwisePathOverlap, queryDefinitions, RESULT_SET_SCHEMA, validateResultSetArtifact } from '../../benchmark/lib/result-sets.mjs';
import { buildReport, renderMarkdown } from '../../benchmark/report.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { writeNote } from '../lib/tree.ts';

const TOOL = join(packageRoot, 'benchmark', 'tools', 'result-sets.mjs');

describe('ranked result-set diagnostic', () => {
  it('captures exact ranked paths from every real store on one logical workload', function () {
    this.timeout(120_000);
    const tree = scratchDir('result-sets-tree');
    writeNote(tree, 'a.md', { body: 'The apple note is first.' });
    writeNote(tree, 'b.md', { body: 'The stone note is second.' });
    writeNote(tree, 'c.md', { body: 'The quiet note is third.' });
    const out = join(scratchDir('result-sets-output'), 'result-sets.json');
    const run = spawnSync(process.execPath, [TOOL, tree, '--queries', 'lexical,words', '--k', '2', '--out', out], { cwd: packageRoot, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(run.error, undefined, run.error?.message ?? 'result-set tool spawn failed');
    assert.equal(run.signal, null, run.stderr);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const artifact = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(artifact.schema, RESULT_SET_SCHEMA);
    assert.equal(artifact.measure_version, MEASURE_VERSION);
    assert.equal(artifact.valid, true, artifact.errors?.join('\n'));
    assert.deepEqual(artifact.stores, [...STORE_NAMES]);
    const corpus = artifact.corpora[tree];
    assert.ok(corpus);
    assert.deepEqual(Object.keys(corpus.stores).sort(), [...STORE_NAMES].sort());
    assert.deepEqual(Object.keys(corpus.overlap).sort(), ['lexical', 'words']);
    assert.equal(corpus.workload.fingerprint, artifact.corpora[tree].stores.sqlite.workload_fingerprint);
    for (const store of STORE_NAMES) {
      for (const query of ['lexical', 'words']) {
        const result = corpus.stores[store].queries[query];
        assert.ok(result);
        assert.ok(result.paths.length <= 2);
        assert.deepEqual(
          result.paths,
          result.rows.map((row: { path: string }) => row.path)
        );
        assert.equal(result.fingerprint.length, 64);
      }
    }
    const missingStore = structuredClone(artifact);
    delete missingStore.corpora[tree].stores.turso;
    assert.match(validateResultSetArtifact(missingStore, { measureVersion: MEASURE_VERSION, stores: [...STORE_NAMES] }).join('\n'), /missing turso result/);
    const errored = structuredClone(artifact);
    errored.errors = ['captured fixture failure'];
    assert.match(validateResultSetArtifact(errored, { measureVersion: MEASURE_VERSION, stores: [...STORE_NAMES] }).join('\n'), /capture errors/);

    const sitting = scratchDir('result-sets-report');
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-01', baseline_version: '0.0.0', machine: {}, node: process.version, changed_paths: [], owed: { baseline: ['fixture'] }, steps: { 'result-sets-hub': { status: 'ok' } }, failed_stage_reasons: [] }));
    writeFileSync(join(sitting, 'result-sets-hub.json'), JSON.stringify(artifact));
    const report = buildReport(sitting, { reportsDir: scratchDir('result-sets-reports') });
    assert.equal(report.verdict, 'BLOCK', 'a partial baseline sitting remains incomplete');
    assert.ok(!report.classifications.some((row: { id: string }) => row.id === 'result-sets-hub/validity'), 'the complete result-set artifact itself remains valid');
    const markdown = renderMarkdown(report);
    assert.match(markdown, /#### Ranked result-set overlap/);
    assert.match(markdown, /Descriptive evidence only/);
    assert.match(markdown, /sqlite \/ duckdb/);

    const invalidSitting = scratchDir('result-sets-invalid-report');
    const invalidArtifact = structuredClone(artifact);
    const corpusName = Object.keys(invalidArtifact.corpora)[0];
    invalidArtifact.corpora[corpusName].overlap.lexical['sqlite|duckdb'] = null;
    writeFileSync(join(invalidSitting, 'sitting.json'), JSON.stringify({ date: '2099-01-01', baseline_version: '0.0.0', machine: {}, node: process.version, changed_paths: [], owed: { baseline: ['fixture'] }, steps: { 'result-sets-hub': { status: 'ok' } }, failed_stage_reasons: [] }));
    writeFileSync(join(invalidSitting, 'result-sets-hub.json'), JSON.stringify(invalidArtifact));
    const invalidReport = buildReport(invalidSitting, { reportsDir: scratchDir('result-sets-invalid-reports') });
    assert.equal(invalidReport.verdict, 'BLOCK');
    assert.ok(invalidReport.classifications.some((row: { id: string; invalid?: boolean }) => row.id === 'result-sets-hub/validity' && row.invalid === true));
    assert.ok(invalidReport.verdict_reasons.some((reason: string) => reason.includes('persisted overlap does not recompute')));
    const invalidMarkdown = renderMarkdown(invalidReport);
    assert.match(invalidMarkdown, /#### result-sets-hub/);
    assert.match(invalidMarkdown, /persisted overlap does not recompute/);
  });

  it('describes selected-work overlap without treating it as correctness', () => {
    assert.deepEqual(pairwisePathOverlap({ paths: ['a.md', 'b.md'] }, { paths: ['b.md', 'c.md'] }), {
      shared_paths: 1,
      union_paths: 3,
      jaccard_path: 1 / 3,
      top1_same: false,
      only_a: ['a.md'],
      only_b: ['c.md'],
    });
    assert.throws(() => pairwisePathOverlap({ paths: ['a.md', 'a.md'] }, { paths: ['a.md'] }), /duplicates/);
    assert.throws(() => pairwisePathOverlap({ paths: [null] }, { paths: [] }), /nonempty string/);
    assert.equal(pairwisePathOverlap({ paths: [] }, { paths: [] }).top1_same, false);
  });

  it('rejects an incomplete query selection before any store work', () => {
    assert.throws(() => queryDefinitions(['lexical', 'lexical'], 2), /duplicates/);
    assert.throws(() => queryDefinitions(['missing'], 2), /unknown result-set query/);
  });
});
