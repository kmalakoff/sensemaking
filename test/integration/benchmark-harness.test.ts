import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../../benchmark/lib/classify.mjs';
import { DIFF_MAP_PATHS } from '../../benchmark/lib/gates.mjs';
import { MEASURE_VERSION, warmFileCache } from '../../benchmark/lib/measure.mjs';
import { describeLoad, parseTopProcesses, quietMachineCheck } from '../../benchmark/lib/quiet-machine.mjs';
import { INPROC_META_KEYS, ROW_BY_KEY, RUN_META_KEYS, RUN_METRIC_KEYS, rowValue } from '../../benchmark/lib/rows.mjs';
import { treeFingerprint } from '../../benchmark/lib/tree-fingerprint.mjs';
import { aggregateVerdict, classifyCompare, classifyCrossGroup, classifyEval, priorStepLookup } from '../../benchmark/lib/verdict.mjs';
import { gate } from '../lib/gate.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

// benchmark-harness.test.ts: the release-gate instrument's own behavior (classification,
// the diff map, the catalog/run.mjs contract), not sensemaking's product behavior -- see
// testing-standards on why this spans modules and lives here rather than in test/unit/.

const WALL_ROW = { key: 'cold_crawl_ms', label: 'cold crawl (wall)', kind: 'wall', band: 0.2, cross: 0.2 };
const TOKENS_ROW = { key: 'map_tokens', label: '`map` token count', kind: 'tokens' };
const QUALITY_ROW = { key: 'ndcg', label: 'nDCG@10', kind: 'quality' };

describe('classify: band edges', () => {
  it('exactly at the band, either sign, is flat', () => {
    assert.equal(classify(WALL_ROW, 100, 120).verdict, 'flat');
    assert.equal(classify(WALL_ROW, 100, 80).verdict, 'flat');
  });

  it('one unit beyond the band with no reversed run: moved slower, faster faster', () => {
    assert.equal(classify(WALL_ROW, 100, 120.01).verdict, 'moved');
    assert.equal(classify(WALL_ROW, 100, 79.99).verdict, 'faster');
  });

  it('no prior recorded is no-prior, not a block', () => {
    const c = classify(WALL_ROW, null, 100);
    assert.equal(c.verdict, 'no-prior');
  });
});

describe('classify: faster verdict', () => {
  it('beyond band, faster, is its own verdict and never blocks', () => {
    const c = classify(WALL_ROW, 1000, 600);
    assert.equal(c.verdict, 'faster');
    const { verdict, reasons } = aggregateVerdict([{ id: 'row', context: 'compare', ...c }], []);
    assert.equal(verdict, 'PASS');
    assert.deepEqual(reasons, []);
  });

  it('beyond band, slower, stays moved', () => {
    const c = classify(WALL_ROW, 1000, 1400);
    assert.equal(c.verdict, 'moved');
  });
});

describe('quiet machine: the gate names what is keeping it busy', () => {
  const PS = ['%CPU COMM', ' 73.0 /System/Library/PrivateFrameworks/Ecosystem.framework/Support/ecosystemd', ' 40.0 /Users/x/.nvm/versions/node/bin/node', '  2.0 /usr/sbin/cupsd'].join('\n');

  it('blocks above half the cores and passes at the limit', () => {
    assert.equal(quietMachineCheck(7, 14).blocked, false, 'exactly at the limit is quiet');
    assert.equal(quietMachineCheck(7.01, 14).blocked, true);
    assert.equal(quietMachineCheck(1, 2).blocked, false, 'the limit scales with the machine');
    assert.equal(quietMachineCheck(1.01, 2).blocked, true);
  });

  it('reports the busiest processes and drops the quiet ones', () => {
    const top = parseTopProcesses(PS);
    assert.deepEqual(
      top.map((p) => p.percent),
      [73, 40],
      'cupsd at 2% is below the reporting floor'
    );
    assert.equal(top[0].system, true, "a /System/ path is not the reader's to stop");
    assert.equal(top[1].system, false, 'a node process under /Users is');
  });

  it('tells a blocked reader what to stop, and says so when nothing is theirs', () => {
    const mine = describeLoad(12, 14, parseTopProcesses(PS));
    assert.equal(mine.blocked, true);
    assert.match(mine.text, /stop these and run again: node/);
    const systemOnly = describeLoad(
      12,
      14,
      parseTopProcesses(PS).filter((p) => p.system)
    );
    assert.match(systemOnly.text, /nothing here is yours to stop/, 'a machine busy with its own daemons needs waiting, not a hunt');
    assert.doesNotMatch(describeLoad(2, 14, []).text, /exceeds/, 'a quiet machine says so plainly');
  });
});

describe('treeFingerprint: hashes content, not filenames or status letters', () => {
  const untracked = (path: string, text: string) => [{ path, bytes: Buffer.from(text) }];

  it('the same head with two different diffs produces two different keys', () => {
    const a = treeFingerprint({ head: 'abc', diff: 'diff a', untracked: [] });
    const b = treeFingerprint({ head: 'abc', diff: 'diff b', untracked: [] });
    assert.notEqual(a, b);
  });

  it('identical inputs produce the same key twice', () => {
    const inputs = { head: 'abc', diff: 'diff a', untracked: untracked('x.md', 'hello') };
    assert.equal(treeFingerprint(inputs), treeFingerprint(inputs));
  });

  it('an untracked file whose bytes change produces a different key', () => {
    const a = treeFingerprint({ head: 'abc', diff: '', untracked: untracked('x.md', 'hello') });
    const b = treeFingerprint({ head: 'abc', diff: '', untracked: untracked('x.md', 'goodbye') });
    assert.notEqual(a, b);
  });
});

describe('warmFileCache: every timed row measures the same cache state', () => {
  it('reads every indexed file, so a sitting never pays disk reads the next one does not', () => {
    const tree = scratchDir('warmup-tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.md'), 'aaaa');
    writeFileSync(join(tree, 'sub', 'b.md'), 'bbbbbb');
    writeFileSync(join(tree, 'ignored.txt'), 'not markdown');
    assert.equal(warmFileCache(tree), 10, 'every .md byte is read, and nothing else is');
  });

  it('cold_crawl_ms gates cross-sitting again, now the measurement is consistent', () => {
    const row = ROW_BY_KEY.get('cold_crawl_ms');
    assert.ok(row, 'cold_crawl_ms must exist in the catalog');
    assert.ok(typeof row.cross === 'number', 'a warmed measurement carries an ordinary band');
  });
});

describe('classify: reversed-run downgrade', () => {
  it('a reversed run whose delta reverses sign downgrades moved to noise', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 90 } });
    assert.equal(c.verdict, 'noise');
  });

  it('a reversed run whose delta lands inside band downgrades moved to noise', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 110 } });
    assert.equal(c.verdict, 'noise');
  });

  it('a reversed run that agrees (same sign, still beyond band) stays moved', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 135 } });
    assert.equal(c.verdict, 'moved');
  });
});

describe('classify: consistent-growth promotion', () => {
  const build = (ms: number) => ({ inproc: { cold_build_ms: ms } });

  it('beyond band at 2+ of hub/13k/26k in the same direction promotes to moved with a consistency reason', () => {
    const current = { hub: build(130), 'scale-13k': build(260), 'scale-26k': build(400) };
    const prior = { hub: build(100), 'scale-13k': build(200), 'scale-26k': build(400) };
    const out = classifyCrossGroup(current, prior);
    const hub = out.find((c) => c.context === 'hub' && c.key === 'inproc.cold_build_ms');
    assert.equal(hub?.verdict, 'moved');
    assert.match(hub?.reason ?? '', /consistent, grows with size/);
  });

  it('beyond band at only one size, with no agreement elsewhere, is moved without the consistency reason', () => {
    const current = { hub: build(130), 'scale-13k': build(205) };
    const prior = { hub: build(100), 'scale-13k': build(200) };
    const out = classifyCrossGroup(current, prior);
    const hub = out.find((c) => c.context === 'hub' && c.key === 'inproc.cold_build_ms');
    assert.equal(hub?.verdict, 'moved');
    assert.ok(!/consistent/.test(hub?.reason ?? ''));
  });
});

describe('classify: quality rules', () => {
  it('a lower quality metric falls', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.3, { retrievalOwed: true });
    assert.equal(c.verdict, 'fell');
  });

  it('a higher quality metric is flat, improved', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.4, { retrievalOwed: true });
    assert.equal(c.verdict, 'flat');
    assert.match(c.reason ?? '', /improved/);
  });

  it('an unchanged quality metric is flat with no reason', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.34, { retrievalOwed: true });
    assert.equal(c.verdict, 'flat');
    assert.equal(c.reason, null);
  });

  it('any quality change when the diff owed neither fever nor a retrieval-touching gate is moved', () => {
    const risen = classify(QUALITY_ROW, 0.34, 0.4, { retrievalOwed: false });
    const fallen = classify(QUALITY_ROW, 0.34, 0.3, { retrievalOwed: false });
    assert.equal(risen.verdict, 'moved');
    assert.equal(fallen.verdict, 'moved');
  });

  it('classifyEval applies the fell rule per variant, from an eval.mjs-shaped JSON', () => {
    const evalJson = { variants: { semantic: { ndcg: 0.3, rr: 0.5, hit: 0.7 } } };
    const priorEval = { variants: { semantic: { ndcg: 0.34, rr: 0.5, hit: 0.7 } } };
    const out = classifyEval('eval-nfcorpus', evalJson, priorEval, true);
    const ndcg = out.find((c) => c.key === 'ndcg');
    assert.equal(ndcg?.verdict, 'fell');
  });
});

describe('classify: tokens', () => {
  it('any change to a tokens-kind row is a contract', () => {
    assert.equal(classify(TOKENS_ROW, 496, 497).verdict, 'contract');
  });

  it('an unchanged tokens-kind row is flat', () => {
    assert.equal(classify(TOKENS_ROW, 496, 496).verdict, 'flat');
  });
});

describe('classifyCompare: same-sitting compare.mjs JSON', () => {
  it('a forced token mismatch between baseline and local produces a contract classification', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { find_row_tokens: 71 },
        local: { find_row_tokens: 90 },
      },
    };
    const out = classifyCompare(compareJson, null);
    const row = out.find((c) => c.key === 'find_row_tokens');
    assert.equal(row?.verdict, 'contract');
    assert.match(row?.reason ?? '', /71 -> 90/);
  });
});

describe('classifyCompare / classifyCrossGroup: a failed command blocks instead of passing silently', () => {
  it('a null current with an errors entry produces a failed classification, and aggregateVerdict blocks with it first', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { map_ms: 80 },
        local: { map_ms: null, errors: { map_ms: 'exit 1: boom' } },
      },
    };
    const out = classifyCompare(compareJson, null);
    const row = out.find((c) => c.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.match(row?.reason ?? '', /boom/);

    const { verdict, reasons } = aggregateVerdict(out, []);
    assert.equal(verdict, 'BLOCK');
    assert.equal(reasons[0], row?.reason);
  });

  it('a null current with no errors entry is skipped, unchanged behaviour', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { map_ms: 80 },
        local: { map_ms: null },
      },
    };
    const out = classifyCompare(compareJson, null);
    assert.equal(
      out.find((c) => c.key === 'map_ms'),
      undefined
    );
  });

  it('classifyCrossGroup: a null current with an errors entry on that step is failed', () => {
    const out = classifyCrossGroup({ stress: { map_ms: null, errors: { map_ms: 'exit 2: kaboom' } } }, { stress: { map_ms: 80 } });
    const row = out.find((c) => c.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.match(row?.reason ?? '', /kaboom/);
  });

  it('classifyCrossGroup: a null current with no errors entry is skipped', () => {
    const out = classifyCrossGroup({ stress: { map_ms: null } }, { stress: { map_ms: 80 } });
    assert.equal(
      out.find((c) => c.key === 'map_ms'),
      undefined
    );
  });
});

describe('diff map: every path exists in the tree', () => {
  it('every prefix or file the diff map names is a real path under this tree', () => {
    for (const p of DIFF_MAP_PATHS) {
      const full = join(packageRoot, p.endsWith('/') ? p.slice(0, -1) : p);
      assert.ok(existsSync(full), `benchmark/lib/gates.mjs names "${p}", which does not exist`);
    }
  });
});

describe('catalog / run.mjs key agreement', () => {
  it('a run.mjs row on the 20-note synthetic corpus has exactly the catalog wall/inproc/tokens keys', function () {
    this.timeout(120_000);
    const corpus = join(packageRoot, '.tmp', 'cache', 'synthetic-n20-t500-h8-l5-f30-fpn8-s1-c63b9320');
    gate(this, 'benchmark-corpus', existsSync(corpus), `${corpus} is not built; run a benchmark once on this machine to cache it`);
    const outPath = join(packageRoot, '.tmp', 'test', `harness-run-${Date.now()}.json`);
    execFileSync(process.execPath, [join(packageRoot, 'benchmark', 'steps', 'measure-tree.mjs'), packageRoot, corpus, '--out', outPath], { cwd: packageRoot, encoding: 'utf8' });
    const row = JSON.parse(readFileSync(outPath, 'utf8'));
    const topLevelMetricKeys = Object.keys(row).filter((k) => !RUN_META_KEYS.includes(k));
    const inprocMetricKeys = Object.keys(row.inproc).filter((k) => !INPROC_META_KEYS.includes(k));
    const flattened = [...topLevelMetricKeys, ...inprocMetricKeys.map((k) => `inproc.${k}`)].sort();
    assert.deepEqual(flattened, [...RUN_METRIC_KEYS].sort());
    // rowValue reaches every one of them, dotted paths included.
    for (const key of RUN_METRIC_KEYS) assert.notEqual(rowValue(row, key), undefined, `rowValue could not reach ${key}`);
    // open() returns stages on every reconcile, not only the cold build: both update reps must carry theirs.
    assert.ok(row.inproc.update_1_file_stages?.spans, 'update_1_file_ms must carry stages');
    assert.ok(row.inproc.update_10_files_stages?.spans, 'update_10_files_ms must carry stages');
  });
});

describe('prior resolution: per step, never per report', () => {
  // The defect this guards: one prior report for the whole run means a sitting that did not run a
  // step blinds the next sitting that does, and every row of that step reads no-prior, which passes.
  const metricRow = (n: number) => ({
    cold_crawl_ms: n,
    version_canary_ms: 20,
    warm_query_ms: 50,
    find_ms: 60,
    find_row_tokens: 71,
    cold_embed_ms: 200,
    semantic_find_ms: 70,
    map_ms: 80,
    map_tokens: 496,
    peek_ms: 90,
    peek_tokens: 581,
    related_ms: 100,
    related_tokens: 50,
    largest_note_tokens: 1000,
    bulk_change_ms: 500,
    bulk_watch_ms: 150,
    inproc: { cold_build_ms: n * 2, open_nochange_ms: 35, update_1_file_ms: 40, update_10_files_ms: 45 },
  });

  it('a step finds its prior in an older report when the newest report never ran it', async () => {
    const reportsDir = scratchDir('prior-per-step-reports');
    const sitting = scratchDir('prior-per-step-sitting');
    const stamp = (steps: Record<string, unknown>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...(v as object), measure_version: MEASURE_VERSION }]));
    const gateReport = (date: string, steps: Record<string, unknown>) => writeFileSync(join(reportsDir, `${date}-9.9.8-release-gate.json`), JSON.stringify({ date, verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: stamp(steps) }));
    gateReport('2099-01-01', { stress: metricRow(100) });
    gateReport('2099-01-02', {}); // a docs-only sitting: ran no measured step
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify(metricRow(101)));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: ['src/x.ts'], owed: { baseline: ['src/x.ts'] }, steps: {}, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(stress.length > 0, 'the stress step must produce classifications');
    assert.deepEqual(
      stress.filter((c: { verdict: string }) => c.verdict === 'no-prior').map((c: { key: string }) => c.key),
      [],
      'every stress row must find its prior in the older report, across the docs-only sitting between'
    );
    assert.equal((report.prior_from as Record<string, string>).stress, '2099-01-01-9.9.8-release-gate.json');
  });

  it('two releases on one day: the prior is the newest release at or below the baseline, never a later one', async () => {
    const reportsDir = scratchDir('prior-same-day-reports');
    const sitting = scratchDir('prior-same-day-sitting');
    const stamp = (steps: Record<string, unknown>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...(v as object), measure_version: MEASURE_VERSION }]));
    const record = (version: string, value: number) => writeFileSync(join(reportsDir, `2099-01-01-${version}-release-gate.json`), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: stamp({ stress: metricRow(value) }) }));
    record('9.9.7', 90);
    record('9.9.8', 100);
    record('9.9.10', 200); // a later release than the baseline: a re-render after this sitting's own release must not read it
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify(metricRow(101)));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-01', baseline_version: '9.9.8', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: ['src/x.ts'], owed: { baseline: ['src/x.ts'] }, steps: {}, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    assert.equal((report.prior_from as Record<string, string>).stress, '2099-01-01-9.9.8-release-gate.json', 'same-day priors resolve by version, and 9.9.10 is not a prior of a 9.9.8 baseline');
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.equal(stress.filter((c: { verdict: string }) => c.verdict === 'no-prior').length, 0, 'every stress row found its prior on the same day');
  });

  it('a step no earlier report ever ran is a real no-prior', async () => {
    const reportsDir = scratchDir('prior-none-reports');
    const sitting = scratchDir('prior-none-sitting');
    writeFileSync(join(reportsDir, '2099-01-01-9.9.8-release-gate.json'), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: {} }));
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify(metricRow(101)));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: {}, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(
      stress.every((c: { verdict: string }) => c.verdict === 'no-prior'),
      'with no earlier report carrying the step, every row is a real no-prior'
    );
    assert.equal((report.prior_from as Record<string, string>).stress, undefined);
  });
});

describe('priorStepLookup: measure_version, the absent-stamp trap and a real mismatch', () => {
  const metricRow = (n: number) => ({
    cold_crawl_ms: n,
    version_canary_ms: 20,
    warm_query_ms: 50,
    find_ms: 60,
    find_row_tokens: 71,
    cold_embed_ms: 200,
    semantic_find_ms: 70,
    map_ms: 80,
    map_tokens: 496,
    peek_ms: 90,
    peek_tokens: 581,
    related_ms: 100,
    related_tokens: 50,
    largest_note_tokens: 1000,
    bulk_change_ms: 500,
    bulk_watch_ms: 150,
    inproc: { cold_build_ms: n * 2, open_nochange_ms: 35, update_1_file_ms: 40, update_10_files_ms: 45 },
  });

  it('an older report whose step has no measure_version resolves as a prior against current m2 (must NOT be no-prior)', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { stress: { cold_crawl_ms: 100 } } } }];
    const hit = priorStepLookup(priorReports, 'm2')('stress');
    assert.deepEqual(hit, { step: { cold_crawl_ms: 100 }, from: 'old.json' });
  });

  it('a prior stamped m1 against current m2 resolves to no-prior, naming both versions', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { stress: { cold_crawl_ms: 100, measure_version: 'm1' } } } }];
    const hit = priorStepLookup(priorReports, 'm2')('stress');
    assert.deepEqual(hit, { step: null, from: 'old.json', mismatch: { prior: 'm1', current: 'm2' } });
  });

  it('fixture: a step that started and never settled blocks the sitting, named in the verdict', async () => {
    const reportsDir = scratchDir('interrupted-reports');
    const sitting = scratchDir('interrupted-sitting');
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify(metricRow(100)));
    writeFileSync(join(sitting, 'battery-turso-hub.log'), 'partial output, then the kill\n'); // the log exists, the status never got written
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { stress: { status: 'ok' } }, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK', 'an interrupted sitting measured nothing past the kill and must not pass');
    assert.ok(
      (report.verdict_reasons as string[]).some((r) => r.startsWith('battery-turso-hub: started, never finished')),
      `the unfinished step is named: ${JSON.stringify(report.verdict_reasons)}`
    );
  });

  it('fixture: a report-wide m1/m2 mismatch classifies every row no-prior and records prior_harness_mismatch', async () => {
    const reportsDir = scratchDir('measure-version-mismatch-reports');
    const sitting = scratchDir('measure-version-mismatch-sitting');
    writeFileSync(join(reportsDir, '2099-01-01-9.9.8-release-gate.json'), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: { stress: { ...metricRow(100), measure_version: 'm1' } } }));
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify(metricRow(101)));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: {}, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(
      stress.every((c: { verdict: string }) => c.verdict === 'no-prior'),
      'a real harness-version mismatch must classify every row no-prior'
    );
    assert.deepEqual((report.prior_harness_mismatch as Record<string, unknown>).stress, { prior: 'm1', current: MEASURE_VERSION });
  });

  it('an artifact with no measure_version stamp is a prior mismatch at the current version (PLAN.md 3.42: the m2->m3 bump made this the permanent case for an unstamped step)', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { compare: metricRow(100) } } }];
    const hit = priorStepLookup(priorReports, MEASURE_VERSION)('compare');
    assert.deepEqual(hit, { step: null, from: 'old.json', mismatch: { prior: 'm2', current: MEASURE_VERSION } });
  });

  it('an artifact stamped with the current measure_version is not a mismatch', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { compare: { ...metricRow(100), measure_version: MEASURE_VERSION } } } }];
    const hit = priorStepLookup(priorReports, MEASURE_VERSION)('compare');
    assert.deepEqual(hit, { step: { ...metricRow(100), measure_version: MEASURE_VERSION }, from: 'old.json' });
  });
});

describe('every step compared against a prior sitting stamps measure_version (PLAN.md 3.42)', () => {
  // Source check, not a run: actually executing every out:true step (13k/26k/stress trees, both
  // eval corpora, every store battery) takes hours. This reads each step's own script instead.
  it('every out:true step in the baseline/scale/quality stages has measure_version in its runner script', async () => {
    const { buildStages } = await import('../../benchmark/lib/stages.mjs');
    // report.mjs's classifySitting only ever calls priorStep() for steps in these three stages
    // (compare/battery-*-hub, scale-13k/26k/stress/battery-*-*, eval-nfcorpus/eval-fever) -- see
    // benchmark/report.mjs. static/functional's out:true steps (store-dump, oracle) are same-sitting
    // pass/fail checks with no prior-comparison concept, so measure_version doesn't apply to them.
    const comparedStageIds = new Set(['baseline', 'scale', 'quality']);
    const steps = buildStages()
      .filter((stage: { id: string }) => comparedStageIds.has(stage.id))
      .flatMap((stage: { steps: Array<{ id: string; argv: string[]; out?: boolean }> }) => stage.steps)
      .filter((step: { out?: boolean }) => step.out);
    assert.ok(steps.length > 0, 'sanity: the compared stages still declare out:true steps');
    for (const step of steps) {
      const script = step.argv[1]; // argv[0] is 'node'
      const src = readFileSync(join(packageRoot, script), 'utf8');
      assert.ok(src.includes('measure_version'), `${step.id} (${script}) writes an artifact a prior sitting is compared against but never stamps measure_version`);
    }
  });
});
