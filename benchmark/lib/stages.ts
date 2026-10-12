// The ordered release-gate pipeline: five stages, each a list of steps. Independent failures are
// collected; gate-dependencies.ts identifies work requiring successful prerequisites. A check is one entry here (plus a catalog
// row once benchmark/lib/rows.ts exists) -- this is the one obvious place a new check goes.
//
// A step is { id, argv, quiet, owedBy, out?, env? }.
//   id      stable string, unique across every stage (compare, scale-13k, scale-26k, stress,
//           eval-nfcorpus, eval-fever, battery-<store>-<corpus>, per the plan; the stage-0/1
//           step ids below are this pass's own naming, not mandated by the plan).
//   argv    the full command, argv[0] the program name resolved on PATH.
//   quiet   true if the step is timing-sensitive (release.mjs's quiet-machine guard applies).
//   owedBy  'always', or a gate name from benchmark/lib/gates.ts -- the diff decides, not a flag.
//   out     true if the step's own script writes --out (a JSON artifact lands beside its log).
//   env     extra environment variables for the child, merged over process.env.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoreName } from 'sensemaking';
import { STORE_NAMES } from 'sensemaking';
import { LIVE_SUITE_ARGV, LIVE_SUITE_ENV } from './gates.ts';

interface Step {
  id: string;
  argv: string[];
  quiet: boolean;
  owedBy: string;
  out?: boolean;
  env?: Record<string, string>;
  failOnOutput?: { pattern: RegExp; why: string };
  unavailableExit?: number;
}
interface Stage {
  id: string;
  label: string;
  steps: Step[];
}

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MINUTES = 60_000;

// Unmarked sittings owe these definitions when FEVER was selected; new assessments collect
// SQLite OR-bag relevance only through an explicit standalone investigation.
export const LEGACY_QUALITY_STEPS: Step[] = [
  { id: 'eval-nfcorpus', argv: ['node', 'benchmark/steps/quality.ts', 'nfcorpus'], quiet: false, owedBy: 'fever', out: true },
  { id: 'eval-fever', argv: ['node', 'benchmark/steps/quality.ts', 'fever'], quiet: false, owedBy: 'fever', out: true },
];

// Every store the built package offers, read from STORE_NAMES through the package's own exports
// map rather than a dist path: a store the library accepts is a store this gate measures.
export const OFFERED = [...STORE_NAMES];
export const DEFAULT_STORE = 'sqlite';
const OTHER_STORES = OFFERED.filter((name) => name !== DEFAULT_STORE);

const run = (...args: string[]) => ['node', 'benchmark/steps/measure-tree.ts', ...args];

const CORPORA = {
  hub: 'obsidian-hub',
  x2: 'obsidian-hub-x2',
  x4: 'obsidian-hub-x4',
  stress: 'stress',
};

// hub for one non-default store, owed by the same gate as stage 2's default-store step (compare).
const storeHubStep = (name: StoreName): Step => ({ id: `battery-${name}-hub`, argv: run('.', CORPORA.hub, '--store', name), quiet: true, owedBy: 'baseline', out: true });

// 13k/26k/stress for one non-default store, owed by the same gate as stage 3's default-store steps.
function storeScaleSteps(name: StoreName): Step[] {
  return [
    { id: `battery-${name}-13k`, argv: run('.', CORPORA.x2, '--store', name), quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-26k`, argv: run('.', CORPORA.x4, '--store', name), quiet: true, owedBy: 'scale', out: true },
    { id: `battery-${name}-stress`, argv: run('.', CORPORA.stress, '--store', name), quiet: true, owedBy: 'scale', out: true },
  ];
}

export function buildStages(): Stage[] {
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
        { id: 'npm-test', argv: ['npm', 'test'], quiet: false, owedBy: 'always' },
        { id: 'test-engines', argv: ['npm', 'run', 'test:engines'], quiet: false, owedBy: 'test-engines' },
        // RELEASING.md step 1: the live suite needs .env.test's real endpoint credentials.
        { id: 'live-suite', argv: LIVE_SUITE_ARGV, quiet: false, owedBy: 'live-suite', env: LIVE_SUITE_ENV },
        // Captures the last release straight from its cached npm install, so no checkout and no
        // second build. The pipeline runs it; nobody drives the capture pair by hand.
        { id: 'store-dump', argv: ['node', 'benchmark/store-dump-ab.ts'], quiet: false, owedBy: 'store-dump', out: true },
        // Opens the vault itself; exits 78 where Obsidian is not installed, which the gate reports
        // as owed-and-unmet rather than a failure.
        { id: 'oracle', argv: ['node', 'benchmark/steps/oracle.ts', '.tmp/cache/obsidian-hub-b11036f9'], quiet: false, owedBy: 'oracle', out: true, unavailableExit: 78 },
      ],
    },
    {
      id: 'baseline',
      label: '2 baseline',
      steps: [
        { id: 'shared-snippet', argv: ['node', 'benchmark/tools/shared-snippet.ts'], quiet: true, owedBy: 'baseline', out: true },
        ...OFFERED.map((name) => ({ id: `native-hydration-${name}`, argv: ['node', 'benchmark/tools/native-hydration.ts', '--store', name], quiet: true, owedBy: 'baseline', out: true })),
        { id: 'native-hydration-comparison', argv: ['node', 'benchmark/tools/native-hydration-compare.ts'], quiet: false, owedBy: 'baseline', out: true },
        // Missing or malformed evidence blocks, so collect it before the expensive timing it
        // protects. The overlap values themselves remain descriptive and never gate a row.
        { id: 'result-sets-hub', argv: ['node', 'benchmark/tools/result-sets.ts', CORPORA.hub], quiet: false, owedBy: 'baseline', out: true },
        { id: 'compare', argv: ['node', 'benchmark/steps/compare-versions.ts'], quiet: true, owedBy: 'baseline', out: true },
        ...OTHER_STORES.map((name) => storeHubStep(name)),
      ],
    },
    {
      id: 'scale',
      label: '3 scale',
      steps: [
        { id: 'result-sets-stress', argv: ['node', 'benchmark/tools/result-sets.ts', CORPORA.stress], quiet: false, owedBy: 'scale', out: true },
        { id: 'scale-13k', argv: run('.', CORPORA.x2), quiet: true, owedBy: 'scale', out: true },
        { id: 'scale-26k', argv: run('.', CORPORA.x4), quiet: true, owedBy: 'scale', out: true },
        { id: 'stress', argv: run('.', CORPORA.stress), quiet: true, owedBy: 'scale', out: true },
        ...OTHER_STORES.flatMap((name) => storeScaleSteps(name)),
      ],
    },
    {
      id: 'quality',
      label: '4 quality',
      steps: [
        { id: 'retained-quality', argv: ['node', 'benchmark/steps/retained-quality.ts'], quiet: false, owedBy: 'quality-revalidation', out: true },
        // Portable NFCorpus is ordinary's all-store relevance view. The comparator checks its
        // identity and full coverage before classification.
        ...portableQualitySteps('nfcorpus', 'quality-baseline'),
        ...portableQualitySteps('fever', 'fever'),
      ],
    },
  ];
}

function portableQualitySteps(corpus: string, owedBy: string): Step[] {
  return [
    ...OFFERED.map((store) => ({ id: `portable-eval-${corpus}-${store}`, argv: ['node', 'benchmark/steps/quality.ts', corpus, '--store', store, '--query-form', 'bare-and'], quiet: false, owedBy, out: true })),
    { id: `portable-eval-${corpus}-comparison`, argv: ['node', 'benchmark/tools/portable-quality-compare.ts'], quiet: false, owedBy, out: true },
  ];
}

export const STAGES = buildStages();
