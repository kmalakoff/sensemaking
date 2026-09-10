// Release benchmark gate: node benchmark/gate.mjs [--profile ordinary|deep] [--dry-run]
// Runs the staged pipeline benchmark/lib/stages.mjs defines, gated by what
// benchmark/lib/gates.mjs says the diff since the last tag owes. Independent failures accumulate;
// failed prerequisites skip dependent work. --dry-run prints what is owed. A run resumes by default:
// the sitting is keyed on the tree it measures, so delete that directory for a clean run. A resume
// skips a step recorded ok, and re-runs a failed one unless the owner accepted its reason
// (report.mjs --accept), so a stage failure never leaves the report by being resumed past.
//
// One store alone, or one tree, is `node benchmark/steps/measure-tree.mjs . <corpus> --store <name>`:
// the steps run standalone, so the gate needs no flag for it.
//
// A report is always written to benchmark/reports/<date>-<version>-release-gate.{json,md} at the end
// (report.mjs), including for a blocked sitting: a report is a record of what happened. The
// verdict decides whether BENCHMARKING.md's numbers of record move, not a flag or a human call.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { releaseChanges } from './lib/changes.mjs';
import { runStageSteps, stepOutputEvidence } from './lib/gate-runner.mjs';
import { assertCompatibleSelection, DEFAULT_PROFILE, ordinaryCostRefusal, PROFILES, profileReasons, remainingCost, resolveRetainedQualityRequirement, retainedQualityForSitting, reversedCompareAction, stepStatus } from './lib/gates.mjs';
import { describeLoad, topProcesses } from './lib/quiet-machine.mjs';
import { assertBuilt } from './lib/require-build.mjs';
import { treeFingerprint } from './lib/tree-fingerprint.mjs';

// Dynamic, and after the check: stages.mjs reaches the built package directly, and report.mjs
// reaches it through stages.mjs, so a static import of either here would fail at resolution
// before any guard could run.
assertBuilt();
const { buildStages, DEFAULT_STORE, MINUTES, OFFERED, ROOT } = await import('./lib/stages.mjs');
const { acceptedIds, comparisonCounts, doneOnResume, failedStageReasons, SITTING_REPORT } = await import('./report.mjs');
const { missingPrerequisites } = await import('./lib/gate-dependencies.mjs');
const { inspectRetainedQuality, retainedQualitySummary } = await import('./lib/retained-quality.mjs');

const {
  values: { 'dry-run': dryRun, help, profile = DEFAULT_PROFILE },
} = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' }, profile: { type: 'string', default: DEFAULT_PROFILE } } });
if (help) {
  console.log('usage: node benchmark/gate.mjs [--profile ordinary|deep] [--dry-run]');
  console.log('ordinary uses portable NFCorpus on every offered store; deep adds FEVER, scale/stress, and legacy OR-bag continuity.');
  console.log('dry-run resolves retained-quality availability and prints the effective requirements without running a gate step.');
  console.log('ordinary stops before execution when remaining work exceeds 20 minutes or has unknown cost; --profile deep explicitly approves that work.');
  process.exit(0);
}
if (!PROFILES.includes(profile)) {
  console.error(`--profile must be ${PROFILES.join(' or ')}`);
  process.exit(2);
}
const STAGES = buildStages();
const ESTIMATE_REPORT = '2026-09-09-0.24.0-release-gate.json';

function estimateEvidence() {
  const report = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'reports', ESTIMATE_REPORT), 'utf8'));
  return {
    steps: Object.fromEntries(Object.entries(report.steps_status ?? {}).map(([id, step]) => [id, Number.isFinite(step?.elapsed_ms) ? step.elapsed_ms : null])),
    source: `${ESTIMATE_REPORT}, release ${report.release_version ?? 'unknown'} on ${report.machine ?? 'unknown machine'}; execution only, excludes setup and quiet waits`,
  };
}

const estimates = estimateEvidence();
function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null;
}

// Paths changed since the last tag, which decide what is owed. Uncommitted changes count, so the
// question answered is "will this diff owe a gate if it ships".
const owedFor = (step, owed) => step.owedBy === 'always' || owed.has(step.owedBy);

/**
 * @param {string} profileName
 * @param {ReturnType<typeof releaseChanges>} changes
 * @param {{ retainedQualityReusable?: boolean }} [options]
 */
async function selection(profileName, changes, { retainedQualityReusable = false } = {}) {
  let reasons = profileReasons(changes.paths, changes.lastTag, profileName, changes.packageJson, changes.packageLock);
  let retainedQuality = null;
  if (reasons.has('quality-revalidation')) {
    const evidence = await inspectRetainedQuality({ reportsDir: join(ROOT, 'benchmark', 'reports'), sittingsDir: join(ROOT, '.tmp', 'sittings'), baselineVersion: packageVersion(), currentRoot: ROOT });
    retainedQuality = retainedQualitySummary(evidence);
    reasons = resolveRetainedQualityRequirement(reasons, evidence, { estimatedMs: estimates.steps['retained-quality'], reusable: retainedQualityReusable });
  }
  const owed = new Set(reasons.keys());
  const selected = STAGES.flatMap((stage) => stage.steps).filter((step) => owedFor(step, owed));
  return { reasons, owed, selected, retainedQuality };
}

function printSelection(changes, selectionResult) {
  const { reasons, owed, estimate, retainedQuality } = selectionResult;
  const reused = new Set(estimate.reused_steps);
  console.log(`profile: ${profile}`);
  console.log(`diff since ${changes.lastTag}: ${changes.paths.length} path(s) changed`);
  if (changes.packageJson) console.log(`  package.json: ${changes.packageJson.classification}${changes.packageJson.changed_fields.length > 0 ? ` (${changes.packageJson.changed_fields.join(', ')})` : ''}`);
  if (changes.packageLock) console.log(`  package-lock.json: ${changes.packageLock.classification}`);
  for (const [gate, matched] of reasons) console.log(`  owes ${gate}: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? `, +${matched.length - 3} more` : ''}`);
  if (retainedQuality) {
    const scope = retainedQuality.scope?.corpus ? `; scope ${retainedQuality.scope.corpus}/${retainedQuality.scope.query_form} on ${(retainedQuality.scope.stores ?? []).join(', ')}` : '';
    console.log(`  retained quality: ${retainedQuality.status}${retainedQuality.source ? ` from ${retainedQuality.source.report}` : ''}${scope}`);
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
}

// Versions read from the built package, never typed. Absent (no build yet) reads as null rather
// than throwing, since --dry-run and a first run before stage 0 both reach this.
async function readBuiltVersions() {
  let chunkVersion = null;
  const schemaVersion = {};
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
const priorSitting = resuming ? JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8')) : null;

const changes = releaseChanges(ROOT);
const { lastTag, paths } = changes;
const retainedQualityReusable = resuming && doneOnResume('retained-quality', priorSitting?.steps?.['retained-quality'], accepted);
const selectionResult = await selection(profile, changes, { retainedQualityReusable });
const { reasons, owed, retainedQuality } = selectionResult;

assertCompatibleSelection(priorSitting, { lastTag, paths, reasons, profile, retainedQuality });
const reusable = (step) => resuming && doneOnResume(step.id, priorSitting?.steps?.[step.id], accepted);
const estimate = { source: estimates.source, ...remainingCost(selectionResult.selected, estimates.steps, reusable) };
printSelection(changes, { ...selectionResult, estimate });
if (dryRun) process.exit(0);
const refusal = ordinaryCostRefusal(profile, estimate);
if (refusal) {
  console.error(`\n${refusal}`);
  process.exit(2);
}

mkdirSync(sittingDir, { recursive: true });
if (resuming) console.log(`resuming ${sittingDir}; steps recorded ok, and failures the owner accepted, are skipped. Delete that directory for a clean run.`);
const sittingRetainedQuality = retainedQualityForSitting(priorSitting?.retained_quality, retainedQuality, reasons);

const sitting = {
  date: priorSitting?.date ?? today,
  baseline_version: priorSitting?.baseline_version ?? baselineVersion,
  last_tag: lastTag,
  machine: { cpu_model: cpus()[0]?.model ?? null, cpu_count: cpus().length, arch: arch() },
  node: process.version,
  chunk_version: priorSitting?.chunk_version ?? null,
  schema_version: priorSitting?.schema_version ?? null,
  changed_paths: paths,
  untracked_paths: changes.untracked,
  package_change: changes.packageJson,
  package_lock_change: changes.packageLock,
  profile,
  effective_requirements: Object.fromEntries(reasons),
  estimated_cost: estimate,
  retained_quality: sittingRetainedQuality,
  owed: Object.fromEntries(reasons),
  steps: priorSitting?.steps ?? {},
  failed_stage_reasons: priorSitting?.failed_stage_reasons ?? [],
};

function writeSitting() {
  writeFileSync(join(sittingDir, 'sitting.json'), `${JSON.stringify(sitting, null, 2)}\n`);
}
writeSitting();

// The recorded status is the resume signal, never the step's own output JSON: a failed step writes
// one too, so reading that as done dropped the failure from the report and from the verdict.
const alreadyDone = (step) => resuming && doneOnResume(step.id, sitting.steps[step.id], accepted);

// Whichever column is measured first reads high on cache-sensitive rows, so sitting.json records
// the order compare.mjs actually spawned.
function recordColumnOrder(step) {
  if (!step.out) return;
  const evidence = stepOutputEvidence(join(sittingDir, `${step.id}.json`));
  const recorded = sitting.steps[step.id];
  sitting.steps[step.id] = { ...recorded, ...evidence, status: recorded.status === 'ok' ? (evidence.status ?? 'ok') : recorded.status };
  if (evidence.detail) console.error(evidence.detail);
}

// The running step, so an interrupt takes its group down with the gate. Each step is its own
// group (runStep), which is what lets a timeout reap grandchildren and what Ctrl-C would miss.
let running = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (running) {
      console.error(`\n${signal}: stopping ${running.id} and its children`);
      try {
        process.kill(-running.pid, 'SIGKILL');
      } catch {}
    }
    process.exit(130);
  });
}

function runStep(step) {
  return new Promise((settle) => {
    const outPath = step.out ? join(sittingDir, `${step.id}.json`) : null;
    const argv2 = outPath ? [...step.argv, '--out', outPath] : step.argv;
    const logPath = join(sittingDir, `${step.id}.log`);
    const logStream = createWriteStream(logPath, { flags: 'w' });
    const started = Date.now();
    // detached, so the timeout kills the group: Node's own `timeout` signals the direct child
    // only, leaving the spawned CLI running and contending with everything measured after it.
    const child = spawn(argv2[0], argv2.slice(1), { cwd: ROOT, env: { ...process.env, ...(step.env ?? {}) }, detached: true });
    let timedOutByUs = false;
    const killGroup = () => {
      timedOutByUs = true;
      // Negative pid targets the whole group. ESRCH means it already exited; nothing else to do.
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
    };
    const timer = step.timeout ? setTimeout(killGroup, step.timeout) : null;
    running = { id: step.id, pid: child.pid };
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      logStream.write(d);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      logStream.write(d);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      logStream.end();
      settle({ status: 'failed', elapsedMs: Date.now() - started, detail: String(err.message ?? err) });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      running = null;
      logStream.end();
      // timedOutByUs, not an elapsed-time guess: the kill is ours, so the flag is exact and a
      // step killed by anything else reads as failed rather than as a timeout.
      let status = timedOutByUs ? 'timeout' : code === 0 ? 'ok' : 'failed';
      let detail;
      if (status === 'ok' && step.failOnOutput && step.failOnOutput.pattern.test(readFileSync(logPath, 'utf8'))) {
        status = 'failed';
        detail = step.failOnOutput.why;
        console.error(`${step.id}: ${detail}`);
      }
      settle({ status, elapsedMs: Date.now() - started, code, signal, detail });
    });
  });
}

// The gate's own untimed stages run an hour at full CPU, and a one-minute load average still
// carries that when the first timed stage starts, so waiting beats failing on the entry reading.
const QUIET_WAIT_MS = 30 * MINUTES;
const QUIET_POLL_MS = 30_000;
const QUIET_REPORT_MS = 2 * MINUTES;

// null once the machine is quiet; the last load reading if it never settled.
async function waitForQuiet(label) {
  const cores = cpus().length;
  const deadline = Date.now() + QUIET_WAIT_MS;
  let nextReport = 0;
  for (;;) {
    const load1 = loadavg()[0];
    const { blocked, text } = describeLoad(load1, cores, topProcesses());
    if (!blocked) return null;
    if (Date.now() >= nextReport) {
      console.error(`\nwaiting to enter ${label}: ${text}`);
      console.error(`retrying every ${QUIET_POLL_MS / 1000}s until ${new Date(deadline).toLocaleTimeString()}`);
      nextReport = Date.now() + QUIET_REPORT_MS;
    }
    if (Date.now() >= deadline) return load1;
    await new Promise((r) => setTimeout(r, QUIET_POLL_MS));
  }
}

for (const stage of STAGES) {
  console.log(`\n===== ${stage.label} =====`);

  const owedSteps = stage.steps.filter((step) => owedFor(step, owed) && !alreadyDone(step) && missingPrerequisites(step.id, STAGES, sitting, accepted).length === 0);
  const needsQuiet = owedSteps.some((step) => step.quiet);
  let quietBlocked = false;
  if (needsQuiet) {
    const load1 = await waitForQuiet(stage.label);
    if (load1 !== null) {
      console.error(`BLOCKED entering ${stage.label} after waiting ${QUIET_WAIT_MS / 60_000} minutes for the machine to settle`);
      quietBlocked = true;
    }
  }

  await runStageSteps(stage.steps, {
    collectIndependent: true,
    isOwed: (step) => owedFor(step, owed),
    resume: (step) => (alreadyDone(step) ? sitting.steps[step.id] : null),
    blockedBy: (step) => [...missingPrerequisites(step.id, STAGES, sitting, accepted), ...(quietBlocked && step.quiet ? ['quiet-machine'] : [])],
    recordBlocked: (step, prerequisites) => {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: prerequisites.includes('quiet-machine') ? 'blocked' : 'not-run', blocked_by: prerequisites };
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
      console.log(recorded.status === 'ok' ? `${step.id}: already done, resuming past it` : `${step.id}: ${recorded.status}, accepted by the owner, resuming past it`);
      sitting.steps[step.id] = { ...recorded, id: step.id, owed: true, resumed: true };
    },
    recordResult: (step, result) => {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, timeout: step.timeout, started: new Date(Date.now() - result.elapsedMs).toISOString(), elapsed_ms: result.elapsedMs, status: stepStatus(step, result), detail: result.detail, load_entry: result.loadEntry, load_exit: loadavg()[0] };
      recordColumnOrder(step);
      const status = sitting.steps[step.id].status;
      writeSitting();
      if (status === 'owed-unmet') console.log(`${step.id}: owed, unmet (its prerequisite is not on this machine)`);
      else if (status !== 'ok') console.error(`${step.id}: ${status} after ${(result.elapsedMs / 1000).toFixed(1)}s`);
      else console.log(`${step.id}: ok in ${(result.elapsedMs / 1000).toFixed(1)}s`);
      return status;
    },
  });

  // A row beyond band is re-run with the column order swapped, keeping both readings. This
  // classify pass is only a "is anything beyond band" probe; report.mjs does the real one.
  if (stage.id === 'baseline' && sitting.steps.compare?.status === 'ok') {
    const compareJsonPath = join(sittingDir, 'compare.json');
    const reversedStep = { id: 'compare-reversed', argv: ['node', 'benchmark/steps/compare-versions.mjs', '--reverse'], timeout: 30 * MINUTES, out: true };
    if (existsSync(compareJsonPath)) {
      const compareJson = JSON.parse(readFileSync(compareJsonPath, 'utf8'));
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
            sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, elapsed_ms: result.elapsedMs, status: result.status, load_entry: result.loadEntry, load_exit: loadavg()[0] };
            recordColumnOrder(step);
            writeSitting();
            if (result.status !== 'ok') console.error(`${step.id}: ${result.status} after ${(result.elapsedMs / 1000).toFixed(1)}s`);
            return sitting.steps[step.id].status;
          },
        });
      } else if (reversedAction === 'accepted') {
        console.log(`compare-reversed: ${reversedRecorded.status}, accepted by the owner, resuming past it`);
        sitting.steps['compare-reversed'] = { ...reversedRecorded, resumed: true };
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
    if (owedFor(step, owed) && !sitting.steps[step.id]?.status) {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'not-run' };
    }
  }
}

const unmetSteps = Object.values(sitting.steps).filter((s) => s.status === 'owed-unmet');
sitting.failed_stage_reasons = failedStageReasons(sitting.steps);
writeSitting();

// Always written, a blocked sitting included: a report records what happened. report.mjs decides
// PASS/BLOCK from the step JSONs and the priors; this file only relays it.
const reportResult = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'report.mjs'), '--sitting', sittingDir], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(reportResult.stdout ?? '');
process.stderr.write(reportResult.stderr ?? '');
if (reportResult.status !== 0) {
  console.error('report.mjs failed to render this sitting; see above');
  process.exit(1);
}
const reportJson = JSON.parse(readFileSync(join(sittingDir, `${SITTING_REPORT}.json`), 'utf8'));

console.log(`\n${reportJson.verdict}`);
if (reportJson.verdict === 'BLOCK') for (const reason of reportJson.verdict_reasons) console.error(`  ${reason}`);
if (unmetSteps.length > 0) console.log(`owed and unmet (not a block): ${unmetSteps.map((s) => s.id).join(', ')}`);
console.log(reportJson.verdict === 'PASS' ? 'numbers of record: repointed once report.mjs --release names this sitting' : 'numbers of record: left as they were (BLOCK)');
const counts = comparisonCounts(reportJson.classifications);
const faster = reportJson.classifications.filter((c) => c.verdict === 'faster').length;
console.log(`comparisons: ${counts.valid} valid numeric, ${counts.invalid} invalid, ${counts.notCompared} not compared; ${faster} faster than band (read the stage split before believing a gain)`);
console.log(`sitting: ${sittingDir}`);
console.log(`report: ${join(sittingDir, `${SITTING_REPORT}.md`)}`);
console.log(`default store for this pipeline: ${DEFAULT_STORE}; offered: ${OFFERED.join(', ')}`);

process.exit(reportJson.verdict === 'BLOCK' ? 1 : 0);
