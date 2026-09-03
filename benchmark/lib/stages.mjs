// The ordered release-gate pipeline: five stages, each a list of steps. A stage that fails stops
// the run; nothing in a later stage is measured. Adding a check is one entry here (plus a catalog
// row once benchmark/lib/rows.mjs exists) -- this is the one obvious place a new check goes.
//
// A step is { id, argv, timeout, quiet, owedBy, out?, env? }.
//   id      stable string, unique across every stage (compare, scale-13k, scale-26k, stress,
//           eval-nfcorpus, eval-fever, battery-<store>-<corpus>, per the plan; the stage-0/1
//           step ids below are this pass's own naming, not mandated by the plan).
//   argv    the full command, argv[0] the program name resolved on PATH.
//   timeout ms; a hung step is killed and the run reports it as failed, not hung forever.
//   quiet   true if the step is timing-sensitive (release.mjs's quiet-machine guard applies).
//   owedBy  'always', or a gate name from benchmark/lib/gates.mjs -- the diff decides, not a flag.
//   out     true if the step's own script writes --out (a JSON artifact lands beside its log).
//   env     extra environment variables for the child, merged over process.env.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STORE_NAMES } from 'sensemaking';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MINUTES = 60_000;

// Every store the built package offers, read from STORE_NAMES through the package's own exports
// map rather than a dist path: a store the library accepts is a store this gate measures.
export const OFFERED = [...STORE_NAMES];
export const DEFAULT_STORE = 'sqlite';
const OTHER_STORES = OFFERED.filter((name) => name !== DEFAULT_STORE);

const run = (...args) => ['node', 'benchmark/steps/measure-tree.mjs', ...args];

const CORPORA = {
  hub: 'obsidian-hub',
  x2: '.tmp/cache/obsidian-hub-x2-x2-hub-1',
  x4: '.tmp/cache/obsidian-hub-x4-x4-hub-1',
  stress: '.tmp/cache/stress-stress-1',
};

// hub for one non-default store, owed by the same gate as stage 2's default-store step (compare).
const storeHubStep = (name) => ({ id: `battery-${name}-hub`, argv: run('.', CORPORA.hub, '--store', name), timeout: 20 * MINUTES, quiet: true, owedBy: 'baseline', out: true });

// 13k/26k/stress for one non-default store, owed by the same gate as stage 3's default-store steps.
function storeScaleSteps(name) {
  return [
    { id: `battery-${name}-13k`, argv: run('.', CORPORA.x2, '--store', name), timeout: 30 * MINUTES, quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-26k`, argv: run('.', CORPORA.x4, '--store', name), timeout: 45 * MINUTES, quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-stress`, argv: run('.', CORPORA.stress, '--store', name), timeout: 30 * MINUTES, quiet: true, owedBy: 'scale', out: true },
  ];
}

export function buildStages() {
  return [
    {
      id: 'static',
      label: '0 static',
      steps: [
        // biome warnings and auto-fix rewrites both exit 0, so the exit code alone reads a
        // warning or rewritten tree as clean.
        {
          id: 'validate',
          argv: ['npx', 'tsds', 'validate'],
          timeout: 10 * MINUTES,
          quiet: false,
          owedBy: 'always',
          failOnOutput: { pattern: /⚠|Fixed \d+ file/, why: 'validate exited 0 but its output carries a biome warning or an auto-fix rewrite; read the output and `git status`, fix it, and run again' },
        },
      ],
    },
    {
      id: 'functional',
      label: '1 functional',
      steps: [
        { id: 'npm-test', argv: ['npm', 'test'], timeout: 10 * MINUTES, quiet: false, owedBy: 'always' },
        { id: 'test-engines', argv: ['npm', 'run', 'test:engines'], timeout: 15 * MINUTES, quiet: false, owedBy: 'test-engines' },
        // RELEASING.md step 1: the live suite needs .env.test's real endpoint credentials.
        { id: 'live-suite', argv: ['npm', 'test'], timeout: 15 * MINUTES, quiet: false, owedBy: 'live-suite', env: { SENSE_TEST_ENV: 'local-release' } },
        // Captures the last release straight from its cached npm install, so no checkout and no
        // second build. The pipeline runs it; nobody drives the capture pair by hand.
        { id: 'store-dump', argv: ['node', 'benchmark/store-dump-ab.mjs'], timeout: 30 * MINUTES, quiet: false, owedBy: 'store-dump', out: true },
        // Opens the vault itself; exits 78 where Obsidian is not installed, which the gate reports
        // as owed-and-unmet rather than a failure.
        { id: 'oracle', argv: ['node', 'benchmark/steps/oracle.mjs', '.tmp/cache/obsidian-hub-b11036f9'], timeout: 20 * MINUTES, quiet: false, owedBy: 'oracle', out: true, unavailableExit: 78 },
      ],
    },
    {
      id: 'baseline',
      label: '2 baseline',
      steps: [{ id: 'compare', argv: ['node', 'benchmark/steps/compare-versions.mjs'], timeout: 30 * MINUTES, quiet: true, owedBy: 'baseline', out: true }, ...OTHER_STORES.map((name) => storeHubStep(name))],
    },
    {
      id: 'scale',
      label: '3 scale',
      steps: [
        { id: 'scale-13k', argv: run('.', CORPORA.x2), timeout: 30 * MINUTES, quiet: true, owedBy: 'scale', out: true },
        { id: 'scale-26k', argv: run('.', CORPORA.x4), timeout: 45 * MINUTES, quiet: true, owedBy: 'scale', out: true },
        { id: 'stress', argv: run('.', CORPORA.stress), timeout: 30 * MINUTES, quiet: true, owedBy: 'scale', out: true },
        ...OTHER_STORES.flatMap((name) => storeScaleSteps(name)),
      ],
    },
    {
      id: 'quality',
      label: '4 quality',
      steps: [
        // nDCG/MRR/hit@10 on a fixed corpus and model: load changes wall time, not the digits, so
        // this stage runs on any machine.
        { id: 'eval-nfcorpus', argv: ['node', 'benchmark/steps/quality.mjs', 'nfcorpus'], timeout: 20 * MINUTES, quiet: false, owedBy: 'quality-baseline', out: true },
        { id: 'eval-fever', argv: ['node', 'benchmark/steps/quality.mjs', 'fever'], timeout: 45 * MINUTES, quiet: false, owedBy: 'fever', out: true },
      ],
    },
  ];
}

export const STAGES = buildStages();
