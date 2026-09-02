// The ordered release-gate pipeline: five stages, each a list of steps. A stage that fails stops
// the run; nothing in a later stage is measured. Adding a check is one entry here (plus a catalog
// row once benchmark/lib/rows.mjs exists) -- this is the one obvious place a new check goes.
//
// A step is { id, argv, timeout, quiet, owedBy, out?, env?, manual? }.
//   id      stable string, unique across every stage (compare, scale-13k, scale-26k, stress,
//           eval-nfcorpus, eval-fever, battery-<store>-<corpus>, per the plan; the stage-0/1
//           step ids below are this pass's own naming, not mandated by the plan).
//   argv    the full command, argv[0] the program name resolved on PATH.
//   timeout ms; a hung step is killed and the run reports it as failed, not hung forever.
//   quiet   true if the step is timing-sensitive (release.mjs's quiet-machine guard applies).
//   owedBy  'always', or a gate name from benchmark/lib/gates.mjs -- the diff decides, not a flag.
//   out     true if the step's own script writes --out (a JSON artifact lands beside its log).
//   env     extra environment variables for the child, merged over process.env.
//   manual  { reason } when release.mjs cannot run the step itself; it is reported owed-and-unmet,
//           never attempted and never counted as a failure (oracle needs Obsidian running; the
//           store-dump A/B needs a checkout and build of the last tag, not yet automated).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticPath } from './corpus.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MINUTES = 60_000;

// Every store schema.json offers: a store a tree can name is a store this gate runs, so the two
// cannot drift apart. sqlite is the default the baseline-bearing steps use.
export const OFFERED = JSON.parse(readFileSync(join(ROOT, 'schema.json'), 'utf8')).properties.store.enum;
export const DEFAULT_STORE = 'sqlite';
const OTHER_STORES = OFFERED.filter((name) => name !== DEFAULT_STORE);

const run = (...args) => ['node', 'benchmark/steps/measure-tree.mjs', ...args];

// Smoke mode swaps every corpus for a small synthetic tree and caps the eval query count, so the
// pipeline can be exercised end to end in minutes. Same steps, same order, same verdict logic.
// Its numbers are not comparable to a real sitting and a smoke report says so.
const SMOKE_NOTES = { hub: 200, x2: 400, x4: 800, stress: 300 };
function corpora(smoke) {
  if (!smoke) {
    return {
      hub: 'obsidian-hub',
      x2: '.tmp/cache/obsidian-hub-x2-x2-hub-1',
      x4: '.tmp/cache/obsidian-hub-x4-x4-hub-1',
      stress: '.tmp/cache/stress-stress-1',
      evalArgs: [],
      scale: 1,
    };
  }
  const tree = (notes) => syntheticPath({ notes, seed: 1 });
  return { hub: tree(SMOKE_NOTES.hub), x2: tree(SMOKE_NOTES.x2), x4: tree(SMOKE_NOTES.x4), stress: tree(SMOKE_NOTES.stress), evalArgs: ['--queries', '20'], scale: 0.1 };
}

// hub for one non-default store, owed by the same gate as stage 2's default-store step (compare).
const storeHubStep = (name, c) => ({ id: `battery-${name}-hub`, argv: run('.', c.hub, '--store', name), timeout: Math.ceil(20 * c.scale) * MINUTES, quiet: true, owedBy: 'baseline', out: true });

// 13k/26k/stress for one non-default store, owed by the same gate as stage 3's default-store steps.
function storeScaleSteps(name, c) {
  const t = (m) => Math.ceil(m * c.scale) * MINUTES;
  return [
    { id: `battery-${name}-13k`, argv: run('.', c.x2, '--store', name), timeout: t(30), quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-26k`, argv: run('.', c.x4, '--store', name), timeout: t(45), quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-stress`, argv: run('.', c.stress, '--store', name), timeout: t(30), quiet: true, owedBy: 'scale', out: true },
  ];
}

export function buildStages({ smoke = false } = {}) {
  const c = corpora(smoke);
  const t = (m) => Math.ceil(m * c.scale) * MINUTES;
  return [
    {
      id: 'static',
      label: '0 static',
      steps: [{ id: 'validate', argv: ['npx', 'tsds', 'validate'], timeout: 10 * MINUTES, quiet: false, owedBy: 'always' }],
    },
    {
      id: 'functional',
      label: '1 functional',
      steps: [
        { id: 'npm-test', argv: ['npm', 'test'], timeout: 10 * MINUTES, quiet: false, owedBy: 'always' },
        { id: 'test-engines', argv: ['npm', 'run', 'test:engines'], timeout: 15 * MINUTES, quiet: false, owedBy: 'test-engines' },
        // RELEASING.md step 1: the live suite needs .env.test's real endpoint credentials.
        { id: 'live-suite', argv: ['npm', 'test'], timeout: 15 * MINUTES, quiet: false, owedBy: 'live-suite', env: { SENSE_TEST_ENV: 'local-release' } },
        { id: 'store-dump', argv: ['node', 'benchmark/steps/store-dump.mjs'], timeout: 20 * MINUTES, quiet: false, owedBy: 'store-dump', manual: { reason: 'A/B against the last tag needs a checkout and build of that tag; not yet automated, run the capture/compare pair by hand (BENCHMARKING.md)' } },
        { id: 'oracle', argv: ['node', 'benchmark/steps/oracle.mjs'], timeout: 10 * MINUTES, quiet: false, owedBy: 'oracle', manual: { reason: 'needs Obsidian running with the vault open (RELEASING.md step 3)' } },
      ],
    },
    {
      id: 'baseline',
      label: '2 baseline',
      steps: [{ id: 'compare', argv: ['node', 'benchmark/steps/compare-versions.mjs', ...(smoke ? [c.hub] : [])], timeout: t(30), quiet: true, owedBy: 'baseline', out: true }, ...OTHER_STORES.map((name) => storeHubStep(name, c))],
    },
    {
      id: 'scale',
      label: '3 scale',
      steps: [
        { id: 'scale-13k', argv: run('.', c.x2), timeout: t(30), quiet: true, owedBy: 'scale', out: true },
        { id: 'scale-26k', argv: run('.', c.x4), timeout: t(45), quiet: true, owedBy: 'scale', out: true },
        { id: 'stress', argv: run('.', c.stress), timeout: t(30), quiet: true, owedBy: 'scale', out: true },
        ...OTHER_STORES.flatMap((name) => storeScaleSteps(name, c)),
      ],
    },
    {
      id: 'quality',
      label: '4 quality',
      steps: [
        // nDCG/MRR/hit@10 on a fixed corpus and model: load changes wall time, not the digits, so
        // this stage runs on any machine.
        { id: 'eval-nfcorpus', argv: ['node', 'benchmark/steps/quality.mjs', 'nfcorpus', ...c.evalArgs], timeout: t(20), quiet: false, owedBy: 'quality-baseline', out: true },
        { id: 'eval-fever', argv: ['node', 'benchmark/steps/quality.mjs', 'fever', ...c.evalArgs], timeout: t(45), quiet: false, owedBy: 'fever', out: true },
      ],
    },
  ];
}

export const STAGES = buildStages();
