import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { renderRowsTable } from '../../benchmark/lib/render.mjs';
import { COMPARISON_CLASSES, ROW_BY_KEY, ROWS } from '../../benchmark/lib/rows.mjs';
import { aggregateVerdict, classifyCompare, classifyCrossGroup, classifyEval, classifyWatchSanity } from '../../benchmark/lib/verdict.mjs';
import { buildReport, comparisonCounts, persist, renderMarkdown } from '../../benchmark/report.mjs';
import { scratchDir } from '../lib/scratch.ts';

const byClass = (name: string) => ROWS.filter((row) => row.comparison_class === name).map((row) => row.key);

describe('benchmark row comparison classes', () => {
  it('assigns the approved class to all 26 catalog rows without certifying a same-candidate row', () => {
    assert.equal(ROWS.length, 26);
    assert.deepEqual(byClass('native-capability'), ['warm_query_ms', 'bulk_change_ms', 'bulk_watch_ms', 'inproc.cold_build_ms', 'inproc.open_nochange_ms', 'inproc.update_1_file_ms', 'inproc.update_10_files_ms']);
    assert.deepEqual(byClass('native-diagnostic'), ['cold_crawl_ms', 'version_canary_ms', 'cold_embed_ms', 'setup_ms', 'find_ms', 'words_ms', 'semantic_find_ms', 'map_ms', 'peek_ms', 'path_ms', 'related_ms', 'inproc.unaccounted_ms']);
    assert.deepEqual(byClass('output-contract'), ['find_row_tokens', 'map_tokens', 'peek_tokens', 'related_tokens']);
    assert.deepEqual(byClass('quality'), ['ndcg', 'rr', 'hit']);
    assert.deepEqual(byClass('same-candidate'), []);
    assert.deepEqual(new Set(ROWS.map((row) => row.comparison_class)), new Set(['native-capability', 'native-diagnostic', 'output-contract', 'quality']));
    assert.deepEqual(Object.keys(COMPARISON_CLASSES), ['native-capability', 'native-diagnostic', 'same-candidate', 'output-contract', 'quality']);
  });

  it('propagates catalog classes through normal, failed, quality, and watcher classifications', () => {
    const compared = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 10 }, local: { map_ms: 11 } } }, null);
    assert.equal(compared.find((row) => row.key === 'map_ms')?.comparison_class, 'native-diagnostic');

    const failed = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 10 }, local: { map_ms: null, errors: { map_ms: 'failed' } } } }, null);
    assert.equal(failed.find((row) => row.key === 'map_ms')?.comparison_class, 'native-diagnostic');

    const cross = classifyCrossGroup({ stress: { warm_query_ms: 10 } }, { stress: { warm_query_ms: 9 } });
    assert.equal(cross.find((row) => row.key === 'warm_query_ms')?.comparison_class, 'native-capability');

    const quality = classifyEval('eval-fixture', { variants: { semantic: { ndcg: 0.7, rr: 0.6, hit: 1, errors: 0 } } }, null, true);
    const qualityRows = quality.filter((row) => row.key !== 'validity');
    assert.equal(qualityRows.length, 3);
    assert.ok(qualityRows.every((row) => 'comparison_class' in row && row.comparison_class === 'quality'));

    assert.equal(classifyWatchSanity('fixture', { bulk_change_ms: 100, bulk_watch_ms: 90 })?.comparison_class, 'native-capability');
  });

  it('leaves validity sentinels unclassified and keeps total movement non-gating', () => {
    const invalid = classifyCompare({ versions: [], results: {} }, null)[0];
    assert.equal(invalid.key, 'validity');
    assert.ok(!('comparison_class' in invalid));

    const total = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { setup_ms: 10 }, local: { setup_ms: 100 } } }, null).find((row) => row.key === 'setup_ms');
    assert.equal(total?.comparison_class, 'native-diagnostic');
    assert.equal(total?.verdict, 'flat');
    assert.equal(aggregateVerdict(total ? [total] : [], []).verdict, 'PASS');

    const failedTotal = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { setup_ms: 10 }, local: { setup_ms: null, errors: { setup_ms: 'failed' } } } }, null).find((row) => row.key === 'setup_ms');
    assert.ok(failedTotal && 'invalid' in failedTotal);
    assert.equal(failedTotal?.comparison_class, 'native-diagnostic');
    assert.equal(failedTotal.invalid, true);
    assert.equal(aggregateVerdict(failedTotal ? [failedTotal] : [], []).verdict, 'BLOCK');
  });

  it('rejects finite out-of-range current and prior quality values without clamping', () => {
    const current = classifyEval('eval-fixture', { variants: { semantic: { ndcg: 1.01, rr: 0.6, hit: 1, errors: 0 } } }, null, true);
    assert.equal(current[0].key, 'validity');
    assert.equal(current[0].invalid, true);
    assert.match(current[0].reason, /out-of-range metric\(s\): ndcg \(ndcg must be between 0 and 1\)/);

    const prior = classifyEval('eval-fixture', { variants: { semantic: { ndcg: 0.7, rr: 0.6, hit: 1, errors: 0 } } }, { variants: { semantic: { ndcg: 0.7, rr: -0.1, hit: 1, errors: 0 } } }, true);
    assert.equal(prior[0].key, 'validity');
    assert.equal(prior[0].invalid, true);
    assert.match(prior[0].reason, /prior artifact is out-of-range/);

    for (const malformed of [null, 'not an object']) {
      const malformedPrior = classifyEval('eval-fixture', { variants: { semantic: { ndcg: 0.7, rr: 0.6, hit: 1, errors: 0 } } }, { variants: { semantic: malformed } }, true);
      assert.equal(malformedPrior[0].key, 'validity');
      assert.equal(malformedPrior[0].invalid, true);
      assert.match(malformedPrior[0].reason, /prior artifact is invalid \(malformed variant\)/);
    }
  });

  it('renders the class beside catalog values', () => {
    const row = ROW_BY_KEY.get('map_tokens');
    assert.ok(row);
    const table = renderRowsTable([row], ['current'], { current: { map_tokens: 42 } });
    assert.match(table, /\| metric \| comparison class \| current \|/);
    assert.match(table, /\| `map` size estimate \(UTF-16 code units \/ 4\) \| output-contract \| ~42 tokens \|/);
  });
});

describe('saved report comparison metadata', () => {
  it('snapshots the current class definitions into a newly built report', () => {
    const sittingDir = scratchDir('row-class-current-report');
    writeFileSync(join(sittingDir, 'sitting.json'), JSON.stringify({ date: '2099-01-01', baseline_version: null, machine: {}, steps: {}, failed_stage_reasons: [] }));
    const report = buildReport(sittingDir, { reportsDir: scratchDir('row-class-current-priors') });
    assert.deepEqual(report.comparison_classes, COMPARISON_CLASSES);
  });

  it('does not infer a class for an old invalid artifact and does not count it as compared', () => {
    const sittingDir = scratchDir('row-class-report');
    const report = {
      date: '2099-01-01',
      title: 'fixture',
      package_version: '1.0.0',
      release_version: null,
      verdict: 'BLOCK',
      verdict_reasons: ['fixture invalid'],
      classifications: [{ id: 'fixture/validity', context: 'fixture', key: 'validity', verdict: 'failed', invalid: true, reason: 'fixture invalid', prior: null, current: null }],
      accepted: {},
      record: {},
      steps_status: {},
      comparison_classes: { legacy: 'Saved historical meaning.' },
      generated: true,
    };

    const { jsonPath, mdPath } = persist(report, { sittingDir });
    const saved = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.ok(!('comparison_class' in saved.classifications[0]));
    assert.deepEqual(saved.comparison_classes, { legacy: 'Saved historical meaning.' });
    const markdown = readFileSync(mdPath, 'utf8');
    assert.match(markdown, /comparisons: 0 valid numeric, 1 invalid, 0 not compared/);
    assert.match(markdown, /legacy: Saved historical meaning\./);
    assert.doesNotMatch(markdown, /native-capability:/);
    assert.match(markdown, /\| validity \| unrecorded \| — \| — \| failed \| BLOCK \| fixture invalid \|/);
    assert.ok(markdown.endsWith(renderMarkdown(saved)));
  });

  it('keeps comparison eligibility, invalidity, and release severity separate', () => {
    const warning = { id: 'timing', context: 'compare', key: 'map_ms', verdict: 'moved', prior: 10, current: 20 };
    const invalid = { id: 'invalid', context: 'compare', key: 'map_ms', verdict: 'failed', invalid: true, prior: 10, current: null };
    const missing = { id: 'missing', context: 'compare', key: 'map_ms', verdict: 'no-compatible-prior', prior: null, current: 20 };
    assert.deepEqual(comparisonCounts([warning, invalid, missing]), { valid: 1, invalid: 1, notCompared: 1 });
    assert.equal(aggregateVerdict([warning], []).verdict, 'PASS');
    assert.equal(aggregateVerdict([invalid], []).verdict, 'BLOCK');
    assert.equal(aggregateVerdict([{ ...warning, release_requirement: 'block' }], []).verdict, 'BLOCK');
  });
});
