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
const DEEP_PROFILE_GATES = ['baseline', 'scale', 'quality-baseline', 'fever'];
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

const QUALITY_COLLECTION_PATHS = [...QUALITY_RETRIEVAL_PATHS.map((path) => (path.endsWith('.ts') ? path : `${path}/`)), 'benchmark/lib/corpus.mjs', 'benchmark/lib/labels.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs', 'benchmark/steps/quality.mjs', 'package-lock.json', 'package.json'];

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

export function profileReasons(paths, lastTag, profile = DEFAULT_PROFILE) {
  if (!PROFILES.includes(profile)) throw new Error(`profile must be ${PROFILES.join(' or ')}`);
  const reasons = owedReasons(paths, lastTag);
  if (profile === 'deep') {
    for (const gate of DEEP_PROFILE_GATES) {
      if (!reasons.has(gate)) reasons.set(gate, ['deep profile']);
    }
    reasons.delete('quality-revalidation');
  }
  const unknownSource = paths.filter((path) => path.startsWith('src/') && !pathOwesRow(path, KNOWN_SOURCE_ROOTS));
  const dependencyInputs = paths.filter((path) => path === 'package.json' || path === 'package-lock.json');
  const conservative = [...unknownSource.map((path) => `${path} (unclassified source path)`), ...dependencyInputs.map((path) => `${path} (dependency input)`)];
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

export function requireFreshQuality(reasons, detail) {
  const next = new Map(reasons);
  next.delete('quality-revalidation');
  for (const gate of ['quality-baseline', 'fever']) {
    const current = next.get(gate) ?? [];
    next.set(gate, [...new Set([...current, detail])]);
  }
  return next;
}

export function resolveRetainedQualityRequirement(reasons, evidence) {
  if (!reasons.has('quality-revalidation') || evidence?.valid === true) return new Map(reasons);
  return requireFreshQuality(reasons, `retained raw quality unavailable: ${evidence?.errors?.[0] ?? evidence?.status ?? 'unknown'}`);
}

export function retainedQualityForSitting(prior, selected, reasons) {
  const freshReplacement = reasons.has('quality-baseline') && reasons.has('fever') && !reasons.has('quality-revalidation');
  if (!freshReplacement) return selected;
  if (!prior && !selected) return null;
  return {
    ...prior,
    ...selected,
    valid: false,
    status: 'superseded-by-fresh-quality',
    source: selected?.source ?? prior?.source ?? null,
    reason: selected?.errors?.[0] ?? prior?.reason ?? 'fresh quality replaces retained revalidation',
  };
}

/** @param {Record<string, unknown> | null} priorSitting @param {{ lastTag: string, paths: string[], reasons: Map<string, string[]>, profile: string, retainedQuality?: { source?: unknown } | null }} selection */
export function assertCompatibleSelection(priorSitting, { lastTag, paths, reasons, profile, retainedQuality = null }) {
  if (!priorSitting) return;
  if (priorSitting.last_tag !== lastTag || JSON.stringify(priorSitting.changed_paths) !== JSON.stringify(paths)) throw new Error('the existing sitting has an incompatible changed-path selection; start a clean sitting');
  if (priorSitting.profile === 'deep' && profile !== 'deep') throw new Error('the existing sitting used the deep profile; resume with --profile deep');
  const priorRequired = new Set(Object.keys(priorSitting.effective_requirements ?? priorSitting.owed ?? {}));
  const freshQualityReplacement = reasons.has('quality-baseline') && reasons.has('fever');
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
