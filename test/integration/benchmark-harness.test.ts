import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../../benchmark/lib/classify.mjs';
import { DIFF_MAP_PATHS } from '../../benchmark/lib/gates.mjs';
import { warmFileCache } from '../../benchmark/lib/measure.mjs';
import { INPROC_META_KEYS, ROW_BY_KEY, RUN_META_KEYS, RUN_METRIC_KEYS, rowValue } from '../../benchmark/lib/rows.mjs';
import { classifyCompare, classifyCrossGroup, classifyEval } from '../../benchmark/lib/verdict.mjs';
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

  it('one unit beyond the band, either sign, is moved with no reversed run', () => {
    assert.equal(classify(WALL_ROW, 100, 120.01).verdict, 'moved');
    assert.equal(classify(WALL_ROW, 100, 79.99).verdict, 'moved');
  });

  it('no prior recorded is no-prior, not a block', () => {
    const c = classify(WALL_ROW, null, 100);
    assert.equal(c.verdict, 'no-prior');
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
    assert.ok(existsSync(corpus), `${corpus} is not cached; run node benchmark/lib/corpus.mjs's synthetic builder first`);
    const outPath = join(packageRoot, '.tmp', 'test', `harness-run-${Date.now()}.json`);
    execFileSync(process.execPath, [join(packageRoot, 'benchmark', 'steps', 'measure-tree.mjs'), packageRoot, corpus, '--out', outPath], { cwd: packageRoot, encoding: 'utf8' });
    const row = JSON.parse(readFileSync(outPath, 'utf8'));
    const topLevelMetricKeys = Object.keys(row).filter((k) => !RUN_META_KEYS.includes(k));
    const inprocMetricKeys = Object.keys(row.inproc).filter((k) => !INPROC_META_KEYS.includes(k));
    const flattened = [...topLevelMetricKeys, ...inprocMetricKeys.map((k) => `inproc.${k}`)].sort();
    assert.deepEqual(flattened, [...RUN_METRIC_KEYS].sort());
    // rowValue reaches every one of them, dotted paths included.
    for (const key of RUN_METRIC_KEYS) assert.notEqual(rowValue(row, key), undefined, `rowValue could not reach ${key}`);
  });
});
