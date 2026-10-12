// Release benchmark gate: node benchmark/gate.ts [--profile ordinary|deep] [--dry-run]
// Runs the staged pipeline benchmark/lib/stages.ts defines, gated by what
// benchmark/lib/gates.ts says the diff since the last tag owes. Independent failures accumulate;
// failed prerequisites skip dependent work. --dry-run prints what is owed. A run resumes by default:
// the sitting is keyed on the tree it measures, so delete that directory for a clean run. A resume
// skips a step recorded ok, and re-runs a failed one unless the owner accepted its reason
// (report.ts --accept), so a stage failure never leaves the report by being resumed past.
//
// One store alone, or one tree, is `node benchmark/steps/measure-tree.ts . <corpus> --store <name>`:
// the steps run standalone, so the gate needs no flag for it.
//
// A report is always written to benchmark/reports/<date>-<version>-release-gate.{json,md} at the end
// (report.ts), including for a blocked sitting: a report is a record of what happened. The
// verdict decides whether BENCHMARKING.md's numbers of record move, not a flag or a human call.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseChanges } from './lib/changes.ts';
import { preserveAttempt, runLoggedJob, runStageSteps, stepOutputEvidence } from './lib/gate-runner.ts';
import { assertCompatibleSelection, DEFAULT_PROFILE, PROFILES, profileReasons, QUALITY_SCOPE, readLiveSuiteCost, remainingCost, resolveRetainedQualityRequirement, retainedQualityForSitting, reversedCompareAction, stepStatus } from './lib/gates.ts';
import { describeLoad, topProcesses } from './lib/quiet-machine.ts';
import { assertBuilt } from './lib/require-build.ts';
import type { OwnedJob } from './lib/step-process.ts';
import { treeFingerprint } from './lib/tree-fingerprint.ts';

// Dynamic, and after the check: stages.ts reaches the built package directly, and report.ts
// reaches it through stages.ts, so a static import of either here would fail at resolution
// before any guard could run.
assertBuilt();
const { buildStages, DEFAULT_STORE, MINUTES, OFFERED, ROOT } = await import('./lib/stages.ts');
const { acceptedIds, comparisonCounts, doneOnResume, failedStageReasons, SITTING_REPORT } = await import('./report.ts');
const { missingPrerequisites } = await import('./lib/gate-dependencies.ts');
const { inspectRetainedQuality, retainedQualitySummary } = await import('./lib/retained-quality.ts');

type Step = ReturnType<typeof buildStages>[number]['steps'][number];
type ExecutableStep = Pick<Step, 'id' | 'argv' | 'out' | 'env' | 'failOnOutput'>;
interface RunResult {
  status: string;
  elapsedMs: number;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  detail?: string;
  job?: { command: unknown; cleanup: string; residual: unknown; cancel_signal: NodeJS.Signals | null };
}
interface EstimateEvidence {
  steps: Record<string, number | null>;
  source: string;
  sources?: Record<string, string>;
}

const {
  values: { 'dry-run': dryRun, help, profile = DEFAULT_PROFILE },
} = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }, profile: { type: 'string', default: DEFAULT_PROFILE } } });
if (help) {
  console.log('usage: node benchmark/gate.ts [--profile ordinary|deep] [--dry-run]');
  console.log('ordinary uses portable NFCorpus on every offered store; deep adds portable FEVER and scale/stress. SQLite OR-bag relevance is an explicit standalone investigation.');
  console.log('dry-run resolves retained-quality availability and prints the effective requirements without running a gate step.');
  console.log('execution estimates are informational; unknown or large costs do not change selected requirements.');
  process.exit(0);
}
if (!PROFILES.includes(profile)) {
  console.error(`--profile must be ${PROFILES.join(' or ')}`);
  process.exit(2);
}
const STAGES = buildStages();
const ESTIMATE_REPORT = '2026-09-09-0.24.0-release-gate.json';

function estimateEvidence(): EstimateEvidence {
  const report: unknown = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'reports', ESTIMATE_REPORT), 'utf8'));
  const historical: EstimateEvidence = {
    steps: Object.fromEntries(Object.entries((report as { steps_status?: Record<string, unknown> }).steps_status ?? {}).map(([id, step]) => [id, Number.isFinite((step as { elapsed_ms?: unknown } | null | undefined)?.elapsed_ms) ? (step as { elapsed_ms: number }).elapsed_ms : null])),
    source: `${ESTIMATE_REPORT}, release ${(report as { release_version?: unknown }).release_version ?? 'unknown'} on ${(report as { machine?: unknown }).machine ?? 'unknown machine'}; execution only, excludes setup and quiet waits`,
  };
  const live = readLiveSuiteCost(ROOT, packageVersion());
  if (live) historical.steps['live-suite'] = live.elapsed_ms;
  historical.sources = live ? { 'live-suite': live.source } : {};
  return historical;
}

const estimates = estimateEvidence();
function packageVersion() {
  return (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version ?? null;
}

// Paths changed since the last tag, which decide what is owed. Uncommitted changes count, so the
// question answered is "will this diff owe a gate if it ships".
const owedFor = (step: Pick<Step, 'owedBy'>, owed: ReadonlySet<string>) => step.owedBy === 'always' || owed.has(step.owedBy);

/** @param {string} profileName @param {ReturnType<typeof releaseChanges>} changes */
async function selection(profileName: string, changes: ReturnType<typeof releaseChanges>) {
  let reasons = profileReasons(changes.paths, changes.lastTag, profileName, changes.packageJson, changes.packageLock);
  let retainedQuality: ReturnType<typeof retainedQualitySummary> | null = null;
  if (reasons.has('quality-revalidation')) {
    const evidence = await inspectRetainedQuality({ reportsDir: join(ROOT, 'benchmark', 'reports'), sittingsDir: join(ROOT, '.tmp', 'sittings'), baselineVersion: packageVersion(), currentRoot: ROOT });
    retainedQuality = retainedQualitySummary(evidence);
    reasons = resolveRetainedQualityRequirement(reasons, evidence);
  }
  const owed = new Set(reasons.keys());
  const selected = STAGES.flatMap((stage) => stage.steps).filter((step) => owedFor(step, owed));
  return { reasons, owed, selected, retainedQuality };
}

function printSelection(changes: ReturnType<typeof releaseChanges>, selectionResult: Awaited<ReturnType<typeof selection>> & { estimate: ReturnType<typeof remainingCost> & { source: string; sources?: Record<string, string> } }) {
  const { reasons, owed, estimate, retainedQuality } = selectionResult;
  const reused = new Set(estimate.reused_steps);
  console.log(`profile: ${profile}`);
  console.log(`diff since ${changes.lastTag}: ${changes.paths.length} path(s) changed`);
  if (changes.packageJson) console.log(`  package.json: ${changes.packageJson.classification}${changes.packageJson.changed_fields.length > 0 ? ` (${changes.packageJson.changed_fields.join(', ')})` : ''}`);
  if (changes.packageLock) console.log(`  package-lock.json: ${changes.packageLock.classification}`);
  for (const [gate, matched] of reasons) console.log(`  owes ${gate}: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? `, +${matched.length - 3} more` : ''}`);
  if (retainedQuality) {
    const scope = (retainedQuality.scope as { corpus?: unknown } | null | undefined)?.corpus ? `; scope ${(retainedQuality.scope as { corpus: unknown }).corpus}/${(retainedQuality.scope as { query_form: unknown }).query_form} on ${((retainedQuality.scope as { stores?: string[] }).stores ?? []).join(', ')}` : '';
    console.log(`  retained quality: ${retainedQuality.status}${retainedQuality.source ? ` from ${(retainedQuality.source as { report: unknown }).report}` : ''}${scope}`);
  }
  for (const stage of STAGES) {
    console.log(`\n${stage.label}`);
    for (const step of stage.steps) {
      const isOwed = owedFor(step, owed);
      const estimateMs = estimates.steps[step.id];
      const tag = !isOwed ? 'not owed' : reused.has(step.id) ? 'REUSE' : `OWED${estimateMs === null || estimateMs === undefined ? ' (cost unknown)' : ` (~${(estimateMs / 60000).toFixed(1)} min)`}`;
      console.log(`  ${step.id}: ${tag}`);
    }
  }
  console.log(`\nprior execution estimate: ~${(estimate.known_ms / 60000).toFixed(1)} min known remaining${estimate.unknown_steps.length > 0 ? `; unknown: ${estimate.unknown_steps.join(', ')}` : ''}`);
  console.log(`remaining work: ${estimate.remaining_steps.length > 0 ? estimate.remaining_steps.map((step) => step.id).join(', ') : 'none'}`);
  console.log(`reused work: ${estimate.reused_steps.length > 0 ? estimate.reused_steps.join(', ') : 'none'}`);
  console.log(`estimate basis: ${estimate.source}`);
  for (const [id, source] of Object.entries(estimate.sources ?? {})) console.log(`estimate source ${id}: ${source}`);
}

// Versions read from the built package, never typed. Absent (no build yet) reads as null rather
// than throwing, since --dry-run and a first run before stage 0 both reach this.
async function readBuiltVersions() {
  let chunkVersion: unknown = null;
  const schemaVersion: Record<string, unknown> = {};
  try {
    ({ CHUNK_VERSION: chunkVersion } = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'chunk', 'version.js')).href));
  } catch {}
  for (const name of OFFERED) {
    try {
      const mod = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', name, 'open.js')).href);
      schemaVersion[name] = mod.SCHEMA_VERSION ?? null;
    } catch {
      schemaVersion[name] = null;
    }
  }
  return { chunkVersion, schemaVersion };
}

// A short hash of HEAD plus the content of every tracked and untracked change. It names the
// sitting, so an edit starts a fresh one instead of resuming onto stale numbers.
function currentTreeFingerprint() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout ?? '';
  const diff = spawnSync('git', ['diff', 'HEAD'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }).stdout ?? '';
  const untrackedOut = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }).stdout ?? '';
  const untracked = untrackedOut
    .split('\0')
    .filter(Boolean)
    .map((path) => ({ path, bytes: readFileSync(join(ROOT, path)) }));
  return treeFingerprint({ head, diff, untracked });
}

const today = new Date().toISOString().slice(0, 10);
const baselineVersion = packageVersion();
// Resuming is the default and needs no flag: a run that crashed or was interrupted picks up where
// it stopped. Delete the directory the run prints to start clean.
const sittingDir = join(ROOT, '.tmp', 'sittings', `${today}-${baselineVersion}-${currentTreeFingerprint()}`);
const resuming = existsSync(join(sittingDir, 'sitting.json'));
// Read before anything is rewritten: the owner's accepted stage reasons decide which recorded
// failures this resume keeps rather than re-runs.
const accepted = acceptedIds(sittingDir);
const priorSitting: unknown = resuming ? JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8')) : null;

const changes = releaseChanges(ROOT);
const { lastTag, paths } = changes;
const selectionResult = await selection(profile, changes);
const { reasons, owed, retainedQuality } = selectionResult;

assertCompatibleSelection(priorSitting, { lastTag, paths, reasons, profile, qualityScope: QUALITY_SCOPE, retainedQuality });
const reusable = (step: Pick<Step, 'id'>) => resuming && doneOnResume(step.id, (priorSitting as { steps?: Record<string, unknown> } | null | undefined)?.steps?.[step.id], accepted);
const estimate = { source: estimates.source, sources: estimates.sources, ...remainingCost(selectionResult.selected, estimates.steps, reusable) };
printSelection(changes, { ...selectionResult, estimate });
if (dryRun) process.exit(0);

mkdirSync(sittingDir, { recursive: true });
if (resuming) console.log(`resuming ${sittingDir}; steps recorded ok, and failures the owner accepted, are skipped. Delete that directory for a clean run.`);
const sittingRetainedQuality = retainedQualityForSitting((priorSitting as { retained_quality?: unknown } | null | undefined)?.retained_quality, retainedQuality, reasons);

const sitting = {
  date: (priorSitting as { date?: unknown } | null | undefined)?.date ?? today,
  baseline_version: (priorSitting as { baseline_version?: unknown } | null | undefined)?.baseline_version ?? baselineVersion,
  last_tag: lastTag,
  machine: { cpu_model: cpus()[0]?.model ?? null, cpu_count: cpus().length, arch: arch() },
  node: process.version,
  chunk_version: ((priorSitting as { chunk_version?: unknown } | null | undefined)?.chunk_version ?? null) as unknown,
  schema_version: (priorSitting as { schema_version?: unknown } | null | undefined)?.schema_version ?? null,
  changed_paths: paths,
  untracked_paths: changes.untracked,
  package_change: changes.packageJson,
  package_lock_change: changes.packageLock,
  profile,
  quality_scope: QUALITY_SCOPE,
  effective_requirements: Object.fromEntries(reasons),
  estimated_cost: estimate,
  retained_quality: sittingRetainedQuality,
  owed: Object.fromEntries(reasons),
  steps: (priorSitting as { steps?: Record<string, unknown> } | null | undefined)?.steps ?? {},
  failed_stage_reasons: (priorSitting as { failed_stage_reasons?: unknown } | null | undefined)?.failed_stage_reasons ?? [],
};

function writeSitting() {
  writeFileSync(join(sittingDir, 'sitting.json'), `${JSON.stringify(sitting, null, 2)}\n`);
}
writeSitting();

// The recorded status is the resume signal, never the step's own output JSON: a failed step writes
// one too, so reading that as done dropped the failure from the report and from the verdict.
const alreadyDone = (step: Pick<Step, 'id'>) => resuming && doneOnResume(step.id, sitting.steps[step.id], accepted);

// Whichever column is measured first reads high on cache-sensitive rows, so sitting.json records
// the order compare.mjs actually spawned.
function recordColumnOrder(step: Pick<Step, 'id' | 'out'>) {
  if (!step.out) return;
  const evidence = stepOutputEvidence(join(sittingDir, `${step.id}.json`));
  const recorded = sitting.steps[step.id];
  sitting.steps[step.id] = { ...(recorded as object), ...evidence, status: (recorded as { status: unknown }).status === 'ok' ? (evidence.status ?? 'ok') : (recorded as { status: unknown }).status };
  if (evidence.detail) console.error(evidence.detail);
}

// Each step is an owned job (step-process.ts): its whole process tree, npm installs and test runners
// included, lives in one group the job's leader anchors. SIGINT or SIGTERM cancels the running job,
// records it `cancelled` and exits 130. No SIGHUP handler: one would override `nohup`; a hangup that
// kills the gate makes each leader release its own group.
let running: { id: string; job: OwnedJob } | null = null;
let cancelling: NodeJS.Signals | null = null;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (cancelling) return void console.error(`\n${signal}: already cancelling (${cancelling})`);
    cancelling = signal;
    if (!running) process.exit(130);
    console.error(`\n${signal}: cancelling ${running.id} and every process in its group`);
    running.job.cancel(signal);
  });
}

async function runStep(step: ExecutableStep): Promise<RunResult> {
  preserveAttempt(sittingDir, step.id, sitting.steps[step.id] ?? null);
  const outPath = step.out ? join(sittingDir, `${step.id}.json`) : null;
  const argv = outPath ? [...step.argv, '--out', outPath] : step.argv;
  const logPath = join(sittingDir, `${step.id}.log`);
  const { result, status: jobStatus, details } = await runLoggedJob(argv, { cwd: ROOT, env: { ...process.env, ...(step.env ?? {}) }, logPath, onStart: (job) => (running = { id: step.id, job }) });
  running = null;
  const outcome = typeof result.command === 'object' ? result.command : { code: null, signal: null };
  let status: string = jobStatus;
  if (status === 'ok' && step.failOnOutput && step.failOnOutput.pattern.test(readFileSync(logPath, 'utf8'))) {
    status = 'failed';
    details.push(step.failOnOutput.why);
  }
  for (const detail of details) console.error(`${step.id}: ${detail}`);
  return { status, elapsedMs: result.elapsed_ms, code: outcome.code, signal: outcome.signal, detail: details.length > 0 ? details.join('; ') : undefined, job: { command: result.command, cleanup: result.cleanup, residual: result.residual, cancel_signal: result.cancel_signal } };
}

// The gate's own untimed stages run an hour at full CPU, and a one-minute load average still
// carries that when the first timed stage starts, so waiting beats failing on the entry reading.
// The wait has no deadline: it ends when the machine is quiet or the run is cancelled.
const QUIET_POLL_MS = 30_000;
const QUIET_REPORT_MS = 2 * MINUTES;

// Resolves once the machine is quiet.
async function waitForQuiet(label: string) {
  const cores = cpus().length;
  let nextReport = 0;
  for (;;) {
    const load1 = loadavg()[0];
    const { blocked, text } = describeLoad(load1, cores, topProcesses());
    if (!blocked) return;
    if (Date.now() >= nextReport) {
      console.error(`\nwaiting to enter ${label}: ${text}`);
      console.error(`retrying every ${QUIET_POLL_MS / 1000}s until the machine is quiet; SIGINT or SIGTERM to the run cancels`);
      nextReport = Date.now() + QUIET_REPORT_MS;
    }
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

for (const stage of STAGES) {
  console.log(`\n===== ${stage.label} =====`);

  const owedSteps = stage.steps.filter((step) => owedFor(step, owed) && !alreadyDone(step) && missingPrerequisites(step.id, STAGES, sitting, accepted).length === 0);
  const needsQuiet = owedSteps.some((step) => step.quiet);
  if (needsQuiet) await waitForQuiet(stage.label);

  await runStageSteps(stage.steps, {
    collectIndependent: true,
    isOwed: (step) => owedFor(step, owed),
    resume: (step) => (alreadyDone(step) ? sitting.steps[step.id] : null),
    blockedBy: (step) => missingPrerequisites(step.id, STAGES, sitting, accepted),
    recordBlocked: (step, prerequisites) => {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'not-run', blocked_by: prerequisites };
      console.error(`${step.id}: not run; unmet prerequisites: ${prerequisites.join(', ')}`);
      writeSitting();
    },
    run: async (step) => {
      console.log(`\n----- ${step.id} -----`);
      const loadEntry = loadavg()[0];
      return { ...(await runStep(step)), loadEntry };
    },
    recordNotOwed: (step) => {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: false, status: 'not-owed' };
    },
    recordResume: (step, recorded) => {
      console.log((recorded as { status: unknown }).status === 'ok' ? `${step.id}: already done, resuming past it` : `${step.id}: ${(recorded as { status: unknown }).status}, accepted by the owner, resuming past it`);
      sitting.steps[step.id] = { ...(recorded as object), id: step.id, owed: true, resumed: true };
    },
    recordResult: (step, result) => {
      sitting.steps[step.id] = {
        id: step.id,
        argv: step.argv,
        owed: true,
        started: new Date(Date.now() - result.elapsedMs).toISOString(),
        elapsed_ms: result.elapsedMs,
        status: result.status === 'cancelled' ? 'cancelled' : stepStatus(step, result),
        code: result.code,
        signal: result.signal,
        detail: result.detail,
        job: result.job,
        load_entry: result.loadEntry,
        load_exit: loadavg()[0],
      };
      recordColumnOrder(step);
      const status = (sitting.steps[step.id] as { status: unknown }).status;
      writeSitting();
      if (status === 'cancelled') {
        console.error(`${step.id}: cancelled; recorded, and re-run on the next resume`);
        process.exit(130);
      }
      if (status === 'owed-unmet') console.log(`${step.id}: owed, unmet (its prerequisite is not on this machine)`);
      else if (status !== 'ok') console.error(`${step.id}: ${status} after ${(result.elapsedMs / 1000).toFixed(1)}s`);
      else console.log(`${step.id}: ok in ${(result.elapsedMs / 1000).toFixed(1)}s`);
      return status;
    },
  });

  // A row beyond band is re-run with the column order swapped, keeping both readings. This
  // classify pass is only a "is anything beyond band" probe; report.ts does the real one.
  if (stage.id === 'baseline' && (sitting.steps.compare as { status?: unknown } | null | undefined)?.status === 'ok') {
    const compareJsonPath = join(sittingDir, 'compare.json');
    const reversedStep = { id: 'compare-reversed', argv: ['node', 'benchmark/steps/compare-versions.ts', '--reverse'], out: true };
    if (existsSync(compareJsonPath)) {
      const compareJson: unknown = JSON.parse(readFileSync(compareJsonPath, 'utf8'));
      const reversedRecorded = sitting.steps['compare-reversed'];
      const reversedAction = reversedCompareAction(compareJson, reversedRecorded, { resuming, accepted });
      if (reversedAction === 'run') {
        console.log('\na timing row moved beyond band on compare; running the reversed re-run (compare.mjs --reverse) to confirm...');
        await runStageSteps([reversedStep], {
          isOwed: () => true,
          resume: () => null,
          run: async (step) => {
            const loadEntry = loadavg()[0];
            return { ...(await runStep(step)), loadEntry };
          },
          recordNotOwed: () => {},
          recordResume: () => {},
          recordResult: (step, result) => {
            sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, elapsed_ms: result.elapsedMs, status: result.status, code: result.code, signal: result.signal, detail: result.detail, job: result.job, load_entry: result.loadEntry, load_exit: loadavg()[0] };
            recordColumnOrder(step);
            writeSitting();
            if (result.status === 'cancelled') process.exit(130);
            if (result.status !== 'ok') console.error(`${step.id}: ${result.status} after ${(result.elapsedMs / 1000).toFixed(1)}s`);
            return (sitting.steps[step.id] as { status: unknown }).status;
          },
        });
      } else if (reversedAction === 'accepted') {
        console.log(`compare-reversed: ${(reversedRecorded as { status: unknown }).status}, accepted by the owner, resuming past it`);
        sitting.steps['compare-reversed'] = { ...(reversedRecorded as object), resumed: true };
        writeSitting();
      }
    }
  }

  // Re-read after each stage rather than once, since --resume can re-enter here after a rebuild.
  if (!sitting.chunk_version) {
    const versions = await readBuiltVersions();
    sitting.chunk_version = versions.chunkVersion;
    sitting.schema_version = versions.schemaVersion;
  }
  writeSitting();
}

// Defensive coverage: no owed step may disappear from the final report.
for (const stage of STAGES) {
  for (const step of stage.steps) {
    if (owedFor(step, owed) && !(sitting.steps[step.id] as { status?: unknown } | null | undefined)?.status) {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'not-run' };
    }
  }
}

const unmetSteps = Object.values(sitting.steps).filter((s) => (s as { status: unknown }).status === 'owed-unmet');
sitting.failed_stage_reasons = failedStageReasons(sitting.steps);
writeSitting();

// Always written, a blocked sitting included: a report records what happened. report.ts decides
// PASS/BLOCK from the step JSONs and the priors; this file only relays it.
const reportResult = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'report.ts'), '--sitting', sittingDir], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(reportResult.stdout ?? '');
process.stderr.write(reportResult.stderr ?? '');
if (reportResult.status !== 0) {
  console.error('report.ts failed to render this sitting; see above');
  process.exit(1);
}
const reportJson: unknown = JSON.parse(readFileSync(join(sittingDir, `${SITTING_REPORT}.json`), 'utf8'));

console.log(`\n${(reportJson as { verdict: unknown }).verdict}`);
if ((reportJson as { verdict: unknown }).verdict === 'BLOCK') for (const reason of (reportJson as { verdict_reasons: Iterable<unknown> }).verdict_reasons) console.error(`  ${reason}`);
if (unmetSteps.length > 0) console.log(`owed and unmet (not a block): ${unmetSteps.map((s) => (s as { id: unknown }).id).join(', ')}`);
console.log((reportJson as { verdict: unknown }).verdict === 'PASS' ? 'numbers of record: repointed once report.ts --release names this sitting' : 'numbers of record: left as they were (BLOCK)');
const counts = comparisonCounts((reportJson as { classifications: Parameters<typeof comparisonCounts>[0] }).classifications);
const faster = (reportJson as { classifications: unknown[] }).classifications.filter((c) => (c as { verdict: unknown }).verdict === 'faster').length;
console.log(`comparisons: ${counts.valid} valid numeric, ${counts.invalid} invalid, ${counts.notCompared} not compared; ${faster} faster than band (read the stage split before believing a gain)`);
console.log(`sitting: ${sittingDir}`);
console.log(`report: ${join(sittingDir, `${SITTING_REPORT}.md`)}`);
console.log(`default store for this pipeline: ${DEFAULT_STORE}; offered: ${OFFERED.join(', ')}`);

process.exit((reportJson as { verdict: unknown }).verdict === 'BLOCK' ? 1 : 0);
