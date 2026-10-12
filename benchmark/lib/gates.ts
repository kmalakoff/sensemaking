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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { join } from 'node:path';
import { QUALITY_RETRIEVAL_PATHS } from './quality-retrieval-identity.ts';
import { shouldRunReversedCompare } from './verdict.ts';
import { directoryIdentity, identityHash, pathSetIdentity } from './workload-identity.ts';

export const LIVE_SUITE_ARGV = ['node', 'node_modules/ts-dev-stack/bin/cli.js', 'test:node', 'test/integration/live.test.ts', '--no-timeouts'];
export const LIVE_SUITE_ENV = { SENSE_TEST_ENV: 'local-release' };
export const LIVE_SUITE_COST_ARTIFACT = '.tmp/live-suite-cost/latest.json';

export function liveSuiteRuntime() {
  return { node: process.version, platform: platform(), arch: arch() };
}

export function liveSuiteMachine() {
  return { cpu_model: cpus()[0]?.model ?? null };
}

export function liveSuiteProvenance(root: string) {
  return {
    harness: {
      live: pathSetIdentity(root, ['test/integration/live.test.ts']),
      helpers: directoryIdentity(join(root, 'test', 'lib')),
    },
    tooling: pathSetIdentity(root, ['benchmark/lib/gates.ts', 'benchmark/lib/stages.ts', 'benchmark/tools/live-suite-cost.ts']),
    package: pathSetIdentity(root, ['package.json', 'package-lock.json']),
    source: directoryIdentity(join(root, 'src')),
    dist_esm: directoryIdentity(join(root, 'dist', 'esm')),
    dist_cjs: directoryIdentity(join(root, 'dist', 'cjs')),
  };
}

export function readLiveSuiteCost(root: string, packageVersion: unknown): { elapsed_ms: number; source: string } | null {
  const artifactPath = join(root, LIVE_SUITE_COST_ARTIFACT);
  try {
    if (!existsSync(artifactPath)) return null;
    const artifact: unknown = JSON.parse(readFileSync(artifactPath, 'utf8'));
    if ((artifact as { schema?: unknown }).schema !== 'live-suite-cost-v1' || (artifact as { status?: unknown }).status !== 'ok' || (artifact as { exit_code?: unknown }).exit_code !== 0 || (artifact as { signal?: unknown }).signal !== null) return null;
    if (JSON.stringify((artifact as { argv?: unknown }).argv) !== JSON.stringify(LIVE_SUITE_ARGV) || JSON.stringify((artifact as { env?: unknown }).env) !== JSON.stringify(LIVE_SUITE_ENV)) return null;
    if (
      (artifact as { package_version?: unknown }).package_version !== packageVersion ||
      !Number.isFinite((artifact as { elapsed_ms?: unknown }).elapsed_ms) ||
      (artifact as { elapsed_ms: number }).elapsed_ms < 0 ||
      !Number.isInteger((artifact as { passing_count?: unknown }).passing_count) ||
      (artifact as { passing_count: number }).passing_count <= 0
    )
      return null;
    if (JSON.stringify((artifact as { runtime?: unknown }).runtime) !== JSON.stringify(liveSuiteRuntime()) || JSON.stringify((artifact as { machine?: unknown }).machine) !== JSON.stringify(liveSuiteMachine())) return null;
    if (JSON.stringify((artifact as { provenance?: unknown }).provenance) !== JSON.stringify(liveSuiteProvenance(root))) return null;
    if (JSON.stringify((artifact as { provenance_after?: unknown }).provenance_after) !== JSON.stringify((artifact as { provenance?: unknown }).provenance)) return null;
    if (
      (artifact as { provenance: { source: { status?: unknown } } }).provenance.source.status !== 'recorded' ||
      (artifact as { provenance: { dist_esm: { status?: unknown } } }).provenance.dist_esm.status !== 'recorded' ||
      (artifact as { provenance: { dist_cjs: { status?: unknown } } }).provenance.dist_cjs.status !== 'recorded'
    )
      return null;
    if (!(artifact as { log?: { path?: unknown } | null }).log?.path || !/^[^/\\]+$/.test((artifact as { log: { path?: unknown } }).log.path as string)) return null;
    const logPath = join(root, '.tmp', 'live-suite-cost', (artifact as { log: { path?: unknown } }).log.path as string);
    if (!existsSync(logPath)) return null;
    const logBytes = readFileSync(logPath);
    if ((artifact as { log: { bytes?: unknown } }).log.bytes !== logBytes.length || (artifact as { log: { sha256?: unknown } }).log.sha256 !== createHash('sha256').update(logBytes).digest('hex')) return null;
    return { elapsed_ms: (artifact as { elapsed_ms: number }).elapsed_ms, source: `${LIVE_SUITE_COST_ARTIFACT} (${(artifact as { log: { path?: unknown } }).log.path})` };
  } catch {
    return null;
  }
}

export const DEFAULT_PROFILE = 'ordinary';
export const PROFILES = [DEFAULT_PROFILE, 'deep'];
export const QUALITY_SCOPE = 'portable-only-v1';
const DEEP_PROFILE_GATES = ['baseline', 'scale', 'quality-baseline', 'fever'];
const DEEP_ONLY_GATES = ['scale', 'fever'];
const KNOWN_SOURCE_ROOTS = [
  'src/chunk/',
  'src/cli.ts',
  'src/cli/',
  'src/commands/index.ts',
  'src/commands/map.ts',
  'src/commands/path.ts',
  'src/commands/peek.ts',
  'src/commands/related.ts',
  'src/commands/scope.ts',
  'src/commands/search.ts',
  'src/commands/signals.ts',
  'src/commands/snapshot.ts',
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
  'src/watch-claim.ts',
  'src/watch.ts',
  'src/workers/',
];

const QUALITY_COLLECTION_PATHS = [...QUALITY_RETRIEVAL_PATHS.map((path) => (path.endsWith('.ts') ? path : `${path}/`)), 'benchmark/lib/corpus.ts', 'benchmark/lib/labels.ts', 'benchmark/lib/quality.ts', 'benchmark/lib/quality-work-tree.ts', 'benchmark/steps/quality.ts'];

// These files evaluate retained artifacts and do not supply measurement inputs or producers.
// Mixed producer/evaluator modules and unknown benchmark paths still owe baseline collection.
const REPORT_EVALUATOR_ONLY_PATHS = ['benchmark/report.ts', 'benchmark/lib/portable-quality.ts', 'benchmark/lib/retained-quality.ts', 'benchmark/lib/verdict.ts', 'benchmark/steps/retained-quality.ts', 'benchmark/tools/portable-quality-compare.ts'];

const QUALITY_EVALUATOR_PATHS = [...REPORT_EVALUATOR_ONLY_PATHS, 'benchmark/gate.ts', 'benchmark/lib/changes.ts', 'benchmark/lib/gates.ts', 'benchmark/lib/metrics.ts', 'benchmark/lib/rows.ts', 'benchmark/lib/stages.ts', 'benchmark/lib/workload-identity.ts'];

const DIFF_MAP = [
  { gate: 'test-engines', when: ['src/store/sqlite/', 'src/watch-claim.ts', 'src/watch.ts', 'src/scan/', 'src/workers/', 'package.json'] },
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
function pathOwesRow(path: string, prefixes: readonly string[]) {
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
export function owedReasons(paths: readonly string[], lastTag: string) {
  if (paths.length === 0) return new Map(GATE_NAMES.map((gate) => [gate, [`no diff since ${lastTag}: this tree is the release`]]));
  const reasons = new Map<string, string[]>();
  for (const { gate, when } of DIFF_MAP) {
    const matched = paths.filter((p) => pathOwesRow(p, when) && !(gate === 'baseline' && REPORT_EVALUATOR_ONLY_PATHS.includes(p)));
    if (matched.length > 0) reasons.set(gate, matched);
  }
  return reasons;
}

export function owedGates(paths: readonly string[], lastTag: string) {
  return new Set(owedReasons(paths, lastTag).keys());
}

/**
 * @param {string[]} paths
 * @param {string} lastTag
 * @param {string} [profile]
 * @param {{ classification: string, reason?: unknown } | null} [packageJson]
 * @param {{ classification: string, reason?: unknown } | null} [packageLock]
 */
export function profileReasons(paths: readonly string[], lastTag: string, profile = DEFAULT_PROFILE, packageJson: unknown = null, packageLock: unknown = null) {
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
  if (paths.includes('package.json') && (packageJson as { classification?: unknown } | null | undefined)?.classification === 'dependency') dependencyInputs.push('package.json (dependency input)');
  const unclassifiedPackage =
    paths.includes('package.json') && !['version-scripts-only', 'dependency', 'dev-dependency-pin'].includes((packageJson as { classification?: unknown } | null | undefined)?.classification as string)
      ? [`package.json (${(packageJson as { reason?: unknown } | null | undefined)?.reason ?? 'package contents unclassified'})`]
      : [];
  if (paths.includes('package-lock.json') && !['version-metadata-only', 'dev-dependency-pin'].includes((packageLock as { classification?: unknown } | null | undefined)?.classification as string))
    dependencyInputs.push(`package-lock.json (${(packageLock as { reason?: unknown } | null | undefined)?.reason ?? 'dependency or other lock content changed'})`);
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
export function remainingCost<S extends { id: string }>(selected: readonly S[], stepEstimates: Readonly<Record<string, number | null | undefined>>, reusable: (step: S) => unknown = () => false) {
  const reusedSteps: string[] = [];
  const remainingSteps: { id: string; estimated_ms: number | null }[] = [];
  for (const step of selected) {
    if (reusable(step)) reusedSteps.push(step.id);
    else remainingSteps.push({ id: step.id, estimated_ms: Number.isFinite(stepEstimates[step.id]) && (stepEstimates[step.id] as number) >= 0 ? (stepEstimates[step.id] as number) : null });
  }
  return {
    known_ms: remainingSteps.reduce((total, step) => total + (step.estimated_ms ?? 0), 0),
    unknown_steps: remainingSteps.filter((step) => step.estimated_ms === null).map((step) => step.id),
    remaining_steps: remainingSteps,
    reused_steps: reusedSteps,
  };
}

export function requireFreshQuality(reasons: ReadonlyMap<string, string[]>, detail: string) {
  const next = new Map(reasons);
  next.delete('quality-revalidation');
  const current = next.get('quality-baseline') ?? [];
  next.set('quality-baseline', [...new Set([...current, detail])]);
  return next;
}

/**
 * @param {Map<string, string[]>} reasons
 * @param {{ valid?: boolean, errors?: string[], status?: string } | null} evidence
 */
export function resolveRetainedQualityRequirement(reasons: ReadonlyMap<string, string[]>, evidence: unknown) {
  if (!reasons.has('quality-revalidation')) return new Map(reasons);
  if ((evidence as { valid?: unknown } | null | undefined)?.valid !== true)
    return requireFreshQuality(reasons, `retained raw quality unavailable: ${(evidence as { errors?: { [index: number]: unknown } | null } | null | undefined)?.errors?.[0] ?? (evidence as { status?: unknown } | null | undefined)?.status ?? 'unknown'}`);
  return new Map(reasons);
}

export function retainedQualityForSitting<P, S>(prior: P, selected: S, reasons: ReadonlyMap<string, string[]>): unknown {
  const freshReplacement = reasons.has('quality-baseline') && !reasons.has('quality-revalidation');
  if (!freshReplacement) return selected;
  if (!prior && !selected) return null;
  return {
    ...prior,
    ...selected,
    valid: false,
    status: 'superseded-by-fresh-quality',
    source: (selected as { source?: unknown } | null | undefined)?.source ?? (prior as { source?: unknown } | null | undefined)?.source ?? null,
    reason: (selected as { errors?: { [index: number]: unknown } | null } | null | undefined)?.errors?.[0] ?? reasons.get('quality-baseline')?.at(-1) ?? (prior as { reason?: unknown } | null | undefined)?.reason ?? 'fresh quality replaces retained revalidation',
  };
}

// An omitted scope identifies an unmarked historical selection. New gate execution always
// supplies QUALITY_SCOPE and cannot adopt the historical coverage boundary on resume.
/** @param {unknown} priorSitting @param {{ lastTag: string, paths: string[], reasons: Map<string, string[]>, profile: string, qualityScope?: string, retainedQuality?: { source?: unknown } | null }} selection */
export function assertCompatibleSelection(priorSitting: unknown, { lastTag, paths, reasons, profile, qualityScope, retainedQuality = null }: { lastTag: string; paths: readonly string[]; reasons: ReadonlyMap<string, string[]>; profile: string; qualityScope?: unknown; retainedQuality?: unknown }) {
  if (qualityScope !== undefined && qualityScope !== QUALITY_SCOPE) throw new Error(`quality scope must be ${QUALITY_SCOPE}`);
  if (!priorSitting) return;
  if ((priorSitting as { quality_scope?: unknown }).quality_scope !== undefined && (priorSitting as { quality_scope?: unknown }).quality_scope !== QUALITY_SCOPE) throw new Error(`the existing sitting has an unknown quality scope; expected ${QUALITY_SCOPE}`);
  if ((priorSitting as { quality_scope?: unknown }).quality_scope !== qualityScope) throw new Error('the existing sitting has an incompatible quality scope; start a clean sitting');
  if ((priorSitting as { last_tag?: unknown }).last_tag !== lastTag || JSON.stringify((priorSitting as { changed_paths?: unknown }).changed_paths) !== JSON.stringify(paths)) throw new Error('the existing sitting has an incompatible changed-path selection; start a clean sitting');
  if ((priorSitting as { profile?: unknown }).profile === 'deep' && profile !== 'deep') throw new Error('the existing sitting used the deep profile; resume with --profile deep');
  const priorRequired = new Set(Object.keys(((priorSitting as { effective_requirements?: unknown }).effective_requirements ?? (priorSitting as { owed?: unknown }).owed ?? {}) as object));
  const freshQualityReplacement = reasons.has('quality-baseline') && !reasons.has('quality-revalidation');
  for (const gate of priorRequired) if (!reasons.has(gate) && !(gate === 'quality-revalidation' && freshQualityReplacement)) throw new Error(`the existing sitting requires ${gate}, which profile ${profile} would omit; resume with a compatible profile`);
  if (
    priorRequired.has('quality-revalidation') &&
    reasons.has('quality-revalidation') &&
    identityHash(((priorSitting as { retained_quality?: unknown }).retained_quality as { source?: unknown } | null | undefined)?.source ?? null) !== identityHash((retainedQuality as { source?: unknown } | null | undefined)?.source ?? null)
  )
    throw new Error('the existing sitting selected different retained quality evidence; start a clean sitting');
}

export function stepStatus<R extends { code?: unknown; status: unknown }>(step: { unavailableExit?: unknown }, result: R) {
  return step.unavailableExit !== undefined && result.code === step.unavailableExit ? 'owed-unmet' : result.status;
}

export function reversedCompareAction(compareJson: unknown, recorded: unknown, { resuming = false, accepted = new Set<string>() }: { resuming?: boolean; accepted?: ReadonlySet<string> } = {}) {
  if (!shouldRunReversedCompare(compareJson)) return 'not-needed';
  const done = resuming && ((recorded as { status?: unknown } | null | undefined)?.status === 'ok' || accepted.has(`compare-reversed: ${(recorded as { status?: unknown } | null | undefined)?.status}`));
  if (!done) return 'run';
  return (recorded as { status?: unknown }).status === 'ok' ? 'done' : 'accepted';
}
