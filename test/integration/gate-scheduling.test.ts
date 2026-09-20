import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import assert from 'assert';
import { missingPrerequisites } from '../../benchmark/lib/gate-dependencies.mjs';
import { runStageSteps, stepOutputEvidence } from '../../benchmark/lib/gate-runner.mjs';
import { LIVE_SUITE_ARGV, LIVE_SUITE_COST_ARTIFACT, LIVE_SUITE_ENV, liveSuiteMachine, liveSuiteProvenance, liveSuiteRuntime, ORDINARY_COST_LIMIT_MS, ordinaryCostRefusal, readLiveSuiteCost, remainingCost } from '../../benchmark/lib/gates.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { buildReport, doneOnResume, failedStageReasons, renderMarkdown } from '../../benchmark/report.mjs';
import { scratchDir } from '../lib/scratch.ts';

function liveCostFixture() {
  const root = scratchDir('live-suite-cost');
  for (const path of ['src/embed/index.ts', 'dist/esm/embed/index.js', 'dist/cjs/embed/index.js', 'test/lib/gate.ts', 'test/integration/live.test.ts', 'benchmark/lib/gates.mjs', 'benchmark/lib/stages.mjs', 'benchmark/tools/live-suite-cost.ts']) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `fixture:${path}\n`);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  const logPath = join(root, '.tmp', 'live-suite-cost', 'fixture.log');
  mkdirSync(join(logPath, '..'), { recursive: true });
  writeFileSync(logPath, '1 passing\n');
  const log = readFileSync(logPath);
  const artifact = {
    schema: 'live-suite-cost-v1',
    status: 'ok',
    argv: LIVE_SUITE_ARGV,
    env: LIVE_SUITE_ENV,
    package_version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    runtime: liveSuiteRuntime(),
    machine: liveSuiteMachine(),
    provenance: liveSuiteProvenance(root),
    provenance_after: liveSuiteProvenance(root),
    recorded_at: '2099-01-01T00:00:00.000Z',
    elapsed_ms: 1234,
    timed_out: false,
    exit_code: 0,
    signal: null,
    passing_count: 1,
    log: { path: 'fixture.log', bytes: log.length, sha256: createHash('sha256').update(log).digest('hex') },
  };
  writeFileSync(join(root, LIVE_SUITE_COST_ARTIFACT), `${JSON.stringify(artifact)}\n`);
  return { root, artifact, logPath };
}

describe('release gate independent failure collection', () => {
  it('refuses costly or unknown ordinary work and subtracts only applicable resume work', () => {
    const steps = [{ id: 'costly' }, { id: 'small' }];
    const estimates = { costly: 19 * 60_000, small: 2 * 60_000 };
    const recorded = { costly: { status: 'ok' } };
    const fresh = remainingCost(steps, estimates);
    assert.equal(fresh.known_ms, 21 * 60_000);
    assert.deepEqual(fresh.reused_steps, []);
    assert.match(ordinaryCostRefusal('ordinary', fresh) ?? '', /Remaining work: costly .*small /);

    const applicableResume = remainingCost(steps, estimates, (step: { id: string }) => doneOnResume(step.id, recorded[step.id as keyof typeof recorded]));
    assert.equal(applicableResume.known_ms, 2 * 60_000);
    assert.deepEqual(applicableResume.reused_steps, ['costly']);
    assert.equal(ordinaryCostRefusal('ordinary', applicableResume), null);

    const boundary = remainingCost([{ id: 'boundary' }], { boundary: ORDINARY_COST_LIMIT_MS });
    assert.equal(ordinaryCostRefusal('ordinary', boundary), null);
    assert.match(ordinaryCostRefusal('ordinary', remainingCost([{ id: 'over' }], { over: ORDINARY_COST_LIMIT_MS + 1 })) ?? '', /exceeds the 20\.0 minute limit/);

    const unknown = remainingCost([{ id: 'unknown-collection' }], {});
    assert.match(ordinaryCostRefusal('ordinary', unknown) ?? '', /cost is unknown for unknown-collection/);
    assert.equal(ordinaryCostRefusal('deep', unknown), null);
  });

  it('uses a valid live-suite measurement for cost only, never as completed work', () => {
    const fixture = liveCostFixture();
    const measured = readLiveSuiteCost(fixture.root, JSON.parse(readFileSync(join(fixture.root, 'package.json'), 'utf8')).version);
    assert.deepEqual(measured, { elapsed_ms: 1234, source: '.tmp/live-suite-cost/latest.json (fixture.log)' });
    const remaining = remainingCost([{ id: 'live-suite' }], { 'live-suite': measured?.elapsed_ms }, () => false);
    assert.deepEqual(remaining.reused_steps, []);
    assert.deepEqual(remaining.remaining_steps, [{ id: 'live-suite', estimated_ms: 1234 }]);
  });

  it('rejects failed, zero-test, mismatched, and corrupted live-suite measurements', () => {
    const cases: Array<(artifact: ReturnType<typeof liveCostFixture>['artifact']) => void> = [
      (artifact) => {
        artifact.status = 'failed';
      },
      (artifact) => {
        artifact.passing_count = 0;
      },
      (artifact) => {
        artifact.argv = ['npm', 'test'];
      },
      (artifact) => {
        artifact.runtime.node = 'v0.0.0';
      },
      (artifact) => {
        artifact.provenance.source.status = 'absent';
      },
    ];
    for (const mutate of cases) {
      const fixture = liveCostFixture();
      mutate(fixture.artifact);
      writeFileSync(join(fixture.root, LIVE_SUITE_COST_ARTIFACT), JSON.stringify(fixture.artifact));
      assert.equal(readLiveSuiteCost(fixture.root, JSON.parse(readFileSync(join(fixture.root, 'package.json'), 'utf8')).version), null);
    }
    const corrupted = liveCostFixture();
    writeFileSync(corrupted.logPath, 'corrupted\n');
    assert.equal(readLiveSuiteCost(corrupted.root, JSON.parse(readFileSync(join(corrupted.root, 'package.json'), 'utf8')).version), null);

    const changedSource = liveCostFixture();
    writeFileSync(join(changedSource.root, 'src/embed/index.ts'), 'changed after measurement\n');
    assert.equal(readLiveSuiteCost(changedSource.root, JSON.parse(readFileSync(join(changedSource.root, 'package.json'), 'utf8')).version), null);
  });

  it('records missing or malformed child output as failure without abandoning independent work', async () => {
    const dir = scratchDir('gate-bad-output');
    const records: Record<string, { id: string; status: string; detail?: string }> = {};
    const steps = [
      { id: 'missing', code: '' },
      { id: 'malformed', code: 'fs.writeFileSync(out, "{")' },
      { id: 'independent', code: 'fs.writeFileSync(out, JSON.stringify({ versions: ["current", "baseline"] }))' },
    ];
    const result = await runStageSteps(steps, {
      collectIndependent: true,
      isOwed: () => true,
      resume: () => null,
      recordNotOwed: () => {},
      recordResume: () => {},
      run: (step: (typeof steps)[number]) => {
        const out = join(dir, `${step.id}.json`);
        const child = spawnSync(process.execPath, ['-e', `const fs = require('node:fs'); const out = ${JSON.stringify(out)}; ${step.code}`], { encoding: 'utf8', timeout: 10_000 });
        assert.equal(child.status, 0, child.stderr);
        return { status: 'ok', ...stepOutputEvidence(out) };
      },
      recordResult: (step: { id: string }, recorded: { status: string; detail?: string }) => {
        records[step.id] = { id: step.id, ...recorded };
        return recorded.status;
      },
    });
    assert.equal(result.failed, true);
    assert.deepEqual(failedStageReasons(records), ['missing: failed', 'malformed: failed']);
    assert.match(records.missing.detail ?? '', /invalid step output/);
    assert.match(records.malformed.detail ?? '', /invalid step output/);
    assert.deepEqual(records.independent, { id: 'independent', status: 'ok', column_order: ['current', 'baseline'] });
  });

  it('collects real failures, skips their dependents, completes independent work, and retries only unfinished steps', async () => {
    const dir = scratchDir('gate-collect');
    const stages = buildStages();
    const records: Record<string, { id: string; status: string; blocked_by?: string[] }> = {
      validate: { id: 'validate', status: 'ok' },
      'npm-test': { id: 'npm-test', status: 'ok' },
      'shared-snippet': { id: 'shared-snippet', status: 'ok' },
      'native-hydration-duckdb': { id: 'native-hydration-duckdb', status: 'ok' },
      'native-hydration-turso': { id: 'native-hydration-turso', status: 'ok' },
    };
    const state = { date: '2099-03-02', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: process.version, changed_paths: [], owed: { baseline: ['benchmark/'], scale: ['src/store/'] }, steps: records };
    const steps = [
      { id: 'result-sets-hub', failFirst: true, writesFailureArtifact: true },
      { id: 'native-hydration-sqlite', failFirst: true, writesFailureArtifact: false },
      { id: 'native-hydration-comparison', failFirst: false, writesFailureArtifact: false },
      { id: 'battery-duckdb-hub', failFirst: false, writesFailureArtifact: false },
      { id: 'scale-13k', failFirst: false, writesFailureArtifact: false },
    ];
    const execute = () =>
      runStageSteps(steps, {
        collectIndependent: true,
        isOwed: () => true,
        resume: (step: { id: string }) => (doneOnResume(step.id, records[step.id]) ? records[step.id] : null),
        blockedBy: (step: { id: string }) => missingPrerequisites(step.id, stages, state),
        recordBlocked: (step: { id: string }, blocked_by: string[]) => {
          records[step.id] = { id: step.id, status: 'not-run', blocked_by };
        },
        recordNotOwed: () => {},
        recordResume: () => {},
        run: (step: (typeof steps)[number]) => {
          const countPath = join(dir, `${step.id}.count`);
          const failureArtifact = join(dir, `${step.id}.failure.json`);
          const code = `const fs = require('node:fs');
const countPath = ${JSON.stringify(countPath)};
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
fs.writeFileSync(countPath, String(count + 1));
if (${step.failFirst} && count === 0) {
  if (${step.writesFailureArtifact}) fs.writeFileSync(${JSON.stringify(failureArtifact)}, JSON.stringify({ error: 'intentional command failure' }));
  process.exit(7);
}`;
          const child = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 10_000 });
          assert.equal(child.error, undefined, child.stderr);
          return { status: child.status === 0 ? 'ok' : 'failed' };
        },
        recordResult: (step: { id: string }, result: { status: string }) => {
          records[step.id] = { id: step.id, status: result.status };
          return result.status;
        },
      });
    assert.equal((await execute()).failed, true);
    assert.deepEqual(failedStageReasons(records), ['result-sets-hub: failed', 'native-hydration-sqlite: failed']);
    assert.equal(existsSync(join(dir, 'result-sets-hub.failure.json')), true);
    assert.equal(existsSync(join(dir, 'native-hydration-sqlite.failure.json')), false);
    assert.equal(existsSync(join(dir, 'native-hydration-comparison.count')), false);
    assert.equal(readFileSync(join(dir, 'battery-duckdb-hub.count'), 'utf8'), '1');
    assert.equal(readFileSync(join(dir, 'scale-13k.count'), 'utf8'), '1');
    writeFileSync(join(dir, 'sitting.json'), JSON.stringify({ ...state, failed_stage_reasons: failedStageReasons(records) }));
    const report = buildReport(dir, { reportsDir: scratchDir('gate-collect-priors') });
    assert.equal(report.verdict, 'BLOCK');
    const markdown = renderMarkdown(report);
    assert.match(markdown, /result-sets-hub: failed/);
    assert.match(markdown, /native-hydration-sqlite: failed/);
    assert.match(markdown, /blocked by native-hydration-sqlite/);
    assert.equal((await execute()).failed, false);
    assert.equal((await execute()).failed, false);
    assert.equal(readFileSync(join(dir, 'result-sets-hub.count'), 'utf8'), '2');
    assert.equal(readFileSync(join(dir, 'native-hydration-sqlite.count'), 'utf8'), '2');
    assert.equal(readFileSync(join(dir, 'native-hydration-comparison.count'), 'utf8'), '1');
    assert.equal(readFileSync(join(dir, 'battery-duckdb-hub.count'), 'utf8'), '1');
    assert.equal(readFileSync(join(dir, 'scale-13k.count'), 'utf8'), '1');
  });
});
