import assert from 'node:assert';
import { missingPrerequisites } from '../../benchmark/lib/gate-dependencies.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';

const stages = buildStages();
const sitting = (steps: Record<string, { status: string }>, owed: Record<string, string[]> = {}) => ({ steps, owed });

describe('gate dependencies', () => {
  it('lets independent functional checks continue after validate and requires every owed suite for later work', () => {
    const state = sitting({ validate: { status: 'ok' }, 'npm-test': { status: 'failed' }, 'test-engines': { status: 'ok' }, 'live-suite': { status: 'failed' } }, { 'test-engines': ['src'], 'live-suite': ['src'] });
    assert.deepEqual(missingPrerequisites('test-engines', stages, state), []);
    assert.deepEqual(missingPrerequisites('store-dump', stages, state), ['npm-test', 'live-suite']);
    assert.deepEqual(missingPrerequisites('store-dump', stages, state, new Set(['npm-test: failed', 'live-suite: failed'])), []);
  });

  it('keeps evidence failures independent while requiring successful producer artifacts', () => {
    const state = sitting({
      validate: { status: 'ok' },
      'npm-test': { status: 'ok' },
      'store-dump': { status: 'failed' },
      oracle: { status: 'failed' },
      'shared-snippet': { status: 'failed' },
      'native-hydration-sqlite': { status: 'ok' },
      'native-hydration-duckdb': { status: 'failed' },
      'native-hydration-turso': { status: 'ok' },
    });
    assert.deepEqual(missingPrerequisites('result-sets-hub', stages, state), []);
    assert.deepEqual(missingPrerequisites('native-hydration-sqlite', stages, state), []);
    assert.deepEqual(missingPrerequisites('native-hydration-comparison', stages, state, new Set(['native-hydration-duckdb: failed'])), ['native-hydration-duckdb']);
  });

  it('derives comparison producers without mistaking independent evidence for input dependencies', () => {
    const ok = Object.fromEntries(stages.flatMap((stage) => stage.steps.map(({ id }) => [id, { status: 'ok' }])));
    assert.deepEqual(missingPrerequisites('portable-eval-nfcorpus-comparison', stages, sitting({ ...ok, 'portable-eval-nfcorpus-turso': { status: 'failed' } })), ['portable-eval-nfcorpus-turso']);
    assert.deepEqual(missingPrerequisites('battery-duckdb-hub', stages, sitting({ ...ok, 'result-sets-hub': { status: 'failed' } })), []);
    assert.deepEqual(missingPrerequisites('battery-turso-stress', stages, sitting({ ...ok, 'result-sets-stress': { status: 'failed' } })), []);
    assert.deepEqual(missingPrerequisites('compare-reversed', stages, sitting({ ...ok, compare: { status: 'failed' } })), ['compare']);
  });

  it('reports unknown steps and missing dependency definitions', () => {
    assert.throws(() => missingPrerequisites('unknown', stages, sitting({ validate: { status: 'ok' } })), /unknown gate step/);
    const withoutCompare = stages.map((stage) => ({ ...stage, steps: stage.steps.filter(({ id }) => id !== 'compare') }));
    assert.throws(() => missingPrerequisites('compare-reversed', withoutCompare, sitting({ validate: { status: 'ok' }, 'npm-test': { status: 'ok' } })), /dependency "compare"/);
  });
});
