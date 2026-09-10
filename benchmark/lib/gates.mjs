// Maps paths changed since the last tag to the gates they owe, per the release-gate diff-map
// table. A gate the map owes is never skippable by a flag; the only way to not run it is
// to change this file, which is a reviewed diff.
//
// Rows 1-6 are the diff-map table, verified 2026-09-01 against each gate script's own
// imports (test:engines: src/store/sqlite/connection.ts imports node:sqlite, src/watch.ts imports
// node:fs's watch, src/scan/pool.ts and src/workers/parse.ts run through tinypool -- all
// Node-version-sensitive; live suite: test/integration/live.test.ts imports src/embed/* directly;
// store-dump: dumps tables gated by src/features/* and the embeddings table depends on src/chunk/*
// chunking; oracle: imports src/chunk/index.js's parse() and src/scan/frontmatter.js's
// splitFrontmatter, and diffs tags/links against src/features/tags.ts and links.ts, with sections
// depending on src/features/sections.ts and fences.ts, which both tags and sections share;
// scale/stress: src/scan/pool.ts and reparse.ts drive crawl throughput, src/graph/* feeds the
// map/related/rank commands run.mjs times; fever: src/commands/search.ts is the ranking entry
// point, and src/scan/frontmatter.ts duplicates title/summary into content so bm25() can weight
// them, per its own comment).
//
// Rows 7-8 (baseline, quality-baseline) are not from that table -- they are the pipeline table's
// stage-level "owed when" columns for stage 2 (compare + hub battery) and stage 4's nfcorpus leg,
// which are broader than any single diff-map row. They live here anyway because release.mjs needs
// one function answering "what does this diff owe", not two.

import { QUALITY_RETRIEVAL_PATHS } from './quality-retrieval-identity.mjs';
import { shouldRunReversedCompare } from './verdict.mjs';
import { identityHash } from './workload-identity.mjs';

export const DEFAULT_PROFILE = 'ordinary';
export const PROFILES = [DEFAULT_PROFILE, 'deep'];
export const ORDINARY_COST_LIMIT_MS = 20 * 60_000;
const DEEP_PROFILE_GATES = ['baseline', 'scale', 'quality-baseline', 'fever'];
const DEEP_ONLY_GATES = ['scale', 'fever'];
const KNOWN_SOURCE_ROOTS = [
  'src/chunk/',
  'src/cli/',
  'src/commands/index.ts',
  'src/commands/map.ts',
  'src/commands/peek.ts',
  'src/commands/related.ts',
  'src/commands/scope.ts',
  'src/commands/search.ts',
  'src/commands/signals.ts',
  'src/commands/status.ts',
  'src/config/',
  'src/embed/',
  'src/errors.ts',
  'src/features/',
  'src/graph/',
  'src/index.ts',
  'src/lib/',
  'src/output/',
  'src/scan/',
  'src/store/',
  'src/text/',
  'src/types/',
  'src/watch.ts',
  'src/workers/',
];

const QUALITY_COLLECTION_PATHS = [...QUALITY_RETRIEVAL_PATHS.map((path) => (path.endsWith('.ts') ? path : `${path}/`)), 'benchmark/lib/corpus.mjs', 'benchmark/lib/labels.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs', 'benchmark/steps/quality.mjs'];

const QUALITY_EVALUATOR_PATHS = [
  'benchmark/gate.mjs',
  'benchmark/report.mjs',
  'benchmark/lib/changes.mjs',
  'benchmark/lib/gates.mjs',
  'benchmark/lib/metrics.mjs',
  'benchmark/lib/portable-quality.mjs',
  'benchmark/lib/retained-quality.mjs',
  'benchmark/lib/rows.mjs',
  'benchmark/lib/stages.mjs',
  'benchmark/lib/verdict.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/steps/retained-quality.mjs',
  'benchmark/tools/portable-quality-compare.mjs',
];

const DIFF_MAP = [
  { gate: 'test-engines', when: ['src/store/sqlite/', 'src/watch.ts', 'src/scan/', 'src/workers/', 'package.json'] },
  { gate: 'live-suite', when: ['src/embed/'] },
  { gate: 'store-dump', when: ['src/store/', 'src/chunk/', 'src/features/'] },
  { gate: 'oracle', when: ['src/chunk/', 'src/text/', 'src/scan/frontmatter.ts', 'src/features/tags.ts', 'src/features/links.ts', 'src/features/sections.ts', 'src/features/fences.ts'] },
  { gate: 'scale', when: ['src/store/', 'src/scan/', 'src/chunk/', 'src/features/', 'src/graph/'] },
  { gate: 'fever', when: QUALITY_COLLECTION_PATHS },
  { gate: 'baseline', when: ['src/', 'benchmark/', 'package.json', 'package-lock.json'] },
  { gate: 'quality-baseline', when: QUALITY_COLLECTION_PATHS },
  { gate: 'quality-revalidation', when: QUALITY_EVALUATOR_PATHS },
];

export const GATE_NAMES = DIFF_MAP.map((row) => row.gate);

// Every path or prefix the diff map names, for a harness test to check each one still exists.
export const DIFF_MAP_PATHS = [...new Set(DIFF_MAP.flatMap((row) => row.when))];

// A directory prefix (ends in '/') matches by startsWith; a bare path matches exactly.
function pathOwesRow(path, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
}

// gate name -> the changed paths that triggered it, for --dry-run's explanation. A gate absent
// from the diff owes nothing and is not a key.
//
// A checked-out tag has no diff (`git diff --name-only <tag>` at that tag is empty), so an empty
// paths list means this tree is the release itself, not that nothing changed: every gate is owed,
// including test-engines, live-suite, oracle and store-dump, which the diff map never names on
// their own. oracle already reports owed-unmet without Obsidian; a live-suite or test-engines
// failure on a machine lacking the prerequisite is an ordinary stage failure the owner accepts
// with --accept (3.47) and resumes past -- that is the mechanism, no special case here.
export function owedReasons(paths, lastTag) {
  if (paths.length === 0) return new Map(GATE_NAMES.map((gate) => [gate, [`no diff since ${lastTag}: this tree is the release`]]));
  const reasons = new Map();
  for (const { gate, when } of DIFF_MAP) {
    const matched = paths.filter((p) => pathOwesRow(p, when));
    if (matched.length > 0) reasons.set(gate, matched);
  }
  return reasons;
}

export function owedGates(paths, lastTag) {
  return new Set(owedReasons(paths, lastTag).keys());
}

/**
 * @param {string[]} paths
 * @param {string} lastTag
 * @param {string} [profile]
 * @param {{ classification: string, reason?: string } | null} [packageJson]
 * @param {{ classification: string, reason?: string } | null} [packageLock]
 */
export function profileReasons(paths, lastTag, profile = DEFAULT_PROFILE, packageJson = null, packageLock = null) {
  if (!PROFILES.includes(profile)) throw new Error(`profile must be ${PROFILES.join(' or ')}`);
  const reasons = owedReasons(paths, lastTag);
  if (profile === 'ordinary') for (const gate of DEEP_ONLY_GATES) reasons.delete(gate);
  if (profile === 'deep') {
    for (const gate of DEEP_PROFILE_GATES) {
      if (!reasons.has(gate)) reasons.set(gate, ['deep profile']);
    }
    reasons.delete('quality-revalidation');
  }
  const unknownSource = paths.filter((path) => path.startsWith('src/') && !pathOwesRow(path, KNOWN_SOURCE_ROOTS));
  const dependencyInputs = [];
  if (paths.includes('package.json') && packageJson?.classification === 'dependency') dependencyInputs.push('package.json (dependency input)');
  const unclassifiedPackage = paths.includes('package.json') && packageJson?.classification !== 'version-scripts-only' && packageJson?.classification !== 'dependency' ? [`package.json (${packageJson?.reason ?? 'package contents unclassified'})`] : [];
  if (paths.includes('package-lock.json') && packageLock?.classification !== 'version-metadata-only') dependencyInputs.push(`package-lock.json (${packageLock?.reason ?? 'dependency or other lock content changed'})`);
  const conservative = [...unknownSource.map((path) => `${path} (unclassified source path)`), ...dependencyInputs, ...unclassifiedPackage];
  if (conservative.length > 0) {
    for (const gate of DEEP_PROFILE_GATES) {
      const current = reasons.get(gate) ?? [];
      reasons.set(gate, [...new Set([...current, ...conservative])]);
    }
    reasons.delete('quality-revalidation');
  }
  if (reasons.has('quality-baseline') || reasons.has('fever')) reasons.delete('quality-revalidation');
  else if (reasons.has('baseline') && !reasons.has('quality-revalidation')) reasons.set('quality-revalidation', ['ordinary baseline requires a current quality view']);
  return reasons;
}

/**
 * @param {{ id: string }[]} selected
 * @param {Record<string, number | null | undefined>} stepEstimates
 * @param {(step: { id: string }) => boolean} [reusable]
 */
export function remainingCost(selected, stepEstimates, reusable = () => false) {
  const reusedSteps = [];
  const remainingSteps = [];
  for (const step of selected) {
    if (reusable(step)) reusedSteps.push(step.id);
    else remainingSteps.push({ id: step.id, estimated_ms: Number.isFinite(stepEstimates[step.id]) && stepEstimates[step.id] >= 0 ? stepEstimates[step.id] : null });
  }
  return {
    known_ms: remainingSteps.reduce((total, step) => total + (step.estimated_ms ?? 0), 0),
    unknown_steps: remainingSteps.filter((step) => step.estimated_ms === null).map((step) => step.id),
    remaining_steps: remainingSteps,
    reused_steps: reusedSteps,
  };
}

export function ordinaryCostRefusal(profile, estimate, limitMs = ORDINARY_COST_LIMIT_MS) {
  if (profile === 'deep') return null;
  const overBudget = estimate.known_ms > limitMs;
  if (!overBudget && estimate.unknown_steps.length === 0) return null;
  const causes = [];
  if (overBudget) causes.push(`~${(estimate.known_ms / 60_000).toFixed(1)} minutes of known work exceeds the ${(limitMs / 60_000).toFixed(1)} minute limit`);
  if (estimate.unknown_steps.length > 0) causes.push(`cost is unknown for ${estimate.unknown_steps.join(', ')}`);
  const work = estimate.remaining_steps.map(({ id, estimated_ms }) => `${id} (${estimated_ms === null ? 'unknown' : `~${(estimated_ms / 60_000).toFixed(1)} min`})`).join(', ');
  return `ordinary assessment stopped before execution because ${causes.join(' and ')}. Remaining work: ${work}. Run with --profile deep to approve this costly assessment.`;
}

export function requireFreshQuality(reasons, detail) {
  const next = new Map(reasons);
  next.delete('quality-revalidation');
  const current = next.get('quality-baseline') ?? [];
  next.set('quality-baseline', [...new Set([...current, detail])]);
  return next;
}

/**
 * @param {Map<string, string[]>} reasons
 * @param {{ valid?: boolean, errors?: string[], status?: string } | null} evidence
 * @param {{ estimatedMs?: number | null, reusable?: boolean }} [options]
 */
export function resolveRetainedQualityRequirement(reasons, evidence, { estimatedMs = null, reusable = false } = {}) {
  if (!reasons.has('quality-revalidation')) return new Map(reasons);
  if (evidence?.valid !== true) return requireFreshQuality(reasons, `retained raw quality unavailable: ${evidence?.errors?.[0] ?? evidence?.status ?? 'unknown'}`);
  if (reusable || (Number.isFinite(estimatedMs) && estimatedMs >= 0)) return new Map(reasons);
  return requireFreshQuality(reasons, 'retained quality revalidation has no historical execution estimate; bounded ordinary fallback is fresh portable NFCorpus');
}

export function retainedQualityForSitting(prior, selected, reasons) {
  const freshReplacement = reasons.has('quality-baseline') && !reasons.has('quality-revalidation');
  if (!freshReplacement) return selected;
  if (!prior && !selected) return null;
  return {
    ...prior,
    ...selected,
    valid: false,
    status: 'superseded-by-fresh-quality',
    source: selected?.source ?? prior?.source ?? null,
    reason: selected?.errors?.[0] ?? reasons.get('quality-baseline')?.at(-1) ?? prior?.reason ?? 'fresh quality replaces retained revalidation',
  };
}

/** @param {Record<string, unknown> | null} priorSitting @param {{ lastTag: string, paths: string[], reasons: Map<string, string[]>, profile: string, retainedQuality?: { source?: unknown } | null }} selection */
export function assertCompatibleSelection(priorSitting, { lastTag, paths, reasons, profile, retainedQuality = null }) {
  if (!priorSitting) return;
  if (priorSitting.last_tag !== lastTag || JSON.stringify(priorSitting.changed_paths) !== JSON.stringify(paths)) throw new Error('the existing sitting has an incompatible changed-path selection; start a clean sitting');
  if (priorSitting.profile === 'deep' && profile !== 'deep') throw new Error('the existing sitting used the deep profile; resume with --profile deep');
  const priorRequired = new Set(Object.keys(priorSitting.effective_requirements ?? priorSitting.owed ?? {}));
  const freshQualityReplacement = reasons.has('quality-baseline') && !reasons.has('quality-revalidation');
  for (const gate of priorRequired) if (!reasons.has(gate) && !(gate === 'quality-revalidation' && freshQualityReplacement)) throw new Error(`the existing sitting requires ${gate}, which profile ${profile} would omit; resume with a compatible profile`);
  if (priorRequired.has('quality-revalidation') && reasons.has('quality-revalidation') && identityHash(priorSitting.retained_quality?.source ?? null) !== identityHash(retainedQuality?.source ?? null)) throw new Error('the existing sitting selected different retained quality evidence; start a clean sitting');
}

export function stepStatus(step, result) {
  return step.unavailableExit !== undefined && result.code === step.unavailableExit ? 'owed-unmet' : result.status;
}

export function reversedCompareAction(compareJson, recorded, { resuming = false, accepted = new Set() } = {}) {
  if (!shouldRunReversedCompare(compareJson)) return 'not-needed';
  const done = resuming && (recorded?.status === 'ok' || accepted.has(`compare-reversed: ${recorded?.status}`));
  if (!done) return 'run';
  return recorded.status === 'ok' ? 'done' : 'accepted';
}
