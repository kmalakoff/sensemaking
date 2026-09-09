import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { missingPrerequisites } from '../../benchmark/lib/gate-dependencies.mjs';
import { runStageSteps, stepOutputEvidence } from '../../benchmark/lib/gate-runner.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { buildReport, doneOnResume, failedStageReasons, renderMarkdown } from '../../benchmark/report.mjs';
import { scratchDir } from '../lib/scratch.ts';

describe('release gate independent failure collection', () => {
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
