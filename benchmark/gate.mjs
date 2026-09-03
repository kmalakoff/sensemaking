// Release benchmark gate: node benchmark/gate.mjs [--dry-run]
// Runs the staged pipeline benchmark/lib/stages.mjs defines, gated by what
// benchmark/lib/gates.mjs says the diff since the last tag owes. A stage that fails stops the
// run. --dry-run prints what the diff owes and exits without measuring. A run resumes by default:
// the sitting is keyed on the tree it measures, so delete that directory for a clean run.
//
// One store alone, or one tree, is `node benchmark/steps/measure-tree.mjs . <corpus> --store <name>`:
// the steps run standalone, so the gate needs no flag for it.
//
// A report is always written to benchmark/reports/<date>-<version>-release-gate.{json,md} at the end
// (report.mjs), including for a blocked sitting: a report is a record of what happened. The
// verdict decides whether BENCHMARKING.md's numbers of record move, not a flag or a human call.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { owedReasons } from './lib/gates.mjs';
import { describeLoad, topProcesses } from './lib/quiet-machine.mjs';
import { assertBuilt } from './lib/require-build.mjs';
import { treeFingerprint } from './lib/tree-fingerprint.mjs';
import { SITTING_REPORT } from './report.mjs';

// Dynamic, and after the check: stages.mjs reaches the built package, and a static import here
// would fail at resolution before any guard could run.
assertBuilt();
const { buildStages, DEFAULT_STORE, MINUTES, OFFERED, ROOT } = await import('./lib/stages.mjs');

import { classifyCompare } from './lib/verdict.mjs';

const {
  values: { 'dry-run': dryRun },
} = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const STAGES = buildStages();
function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null;
}

// Paths changed since the last tag, which decide what is owed. Uncommitted changes count, so the
// question answered is "will this diff owe a gate if it ships".
function changedPaths() {
  const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' });
  if (tag.status !== 0) throw new Error(`git describe --tags failed: ${tag.stderr}`);
  const lastTag = tag.stdout.trim();
  const diff = spawnSync('git', ['diff', '--name-only', lastTag], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16e6 });
  if (diff.status !== 0) throw new Error(`git diff --name-only ${lastTag} failed: ${diff.stderr}`);
  return { lastTag, paths: diff.stdout.split('\n').filter(Boolean) };
}

const owedFor = (step, owed) => step.owedBy === 'always' || owed.has(step.owedBy);

if (dryRun) {
  const { lastTag, paths } = changedPaths();
  const reasons = owedReasons(paths);
  const owed = new Set(reasons.keys());
  console.log(`diff since ${lastTag}: ${paths.length} path(s) changed`);
  for (const [gate, matched] of reasons) console.log(`  owes ${gate}: ${matched.slice(0, 3).join(', ')}${matched.length > 3 ? `, +${matched.length - 3} more` : ''}`);
  for (const stage of STAGES) {
    console.log(`\n${stage.label}`);
    for (const step of stage.steps) {
      const isOwed = owedFor(step, owed);
      const tag = !isOwed ? 'not owed' : 'OWED';
      console.log(`  ${step.id}: ${tag}`);
    }
  }
  process.exit(0);
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
mkdirSync(sittingDir, { recursive: true });

// A step killed by its timeout cannot clean up after itself, and each abandoned copy is hundreds
// of MB. Anything left here at the start of a run is from an earlier one.
for (const name of readdirSync(join(ROOT, '.tmp')).filter((n) => n.startsWith('run-'))) {
  safeRmSync(join(ROOT, '.tmp', name), { recursive: true, force: true });
  console.log(`swept abandoned work tree .tmp/${name}`);
}
if (resuming) console.log(`resuming ${sittingDir}; steps already finished are skipped. Delete that directory for a clean run.`);

const priorSitting = existsSync(join(sittingDir, 'sitting.json')) ? JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8')) : null;

const { lastTag, paths } = changedPaths();
const reasons = owedReasons(paths);
const owed = new Set(reasons.keys());

const sitting = {
  date: priorSitting?.date ?? today,
  baseline_version: priorSitting?.baseline_version ?? baselineVersion,
  last_tag: lastTag,
  machine: { cpu_model: cpus()[0]?.model ?? null, cpu_count: cpus().length, arch: arch() },
  node: process.version,
  chunk_version: priorSitting?.chunk_version ?? null,
  schema_version: priorSitting?.schema_version ?? null,
  changed_paths: paths,
  owed: Object.fromEntries(reasons),
  steps: priorSitting?.steps ?? {},
  failed_stage_reasons: priorSitting?.failed_stage_reasons ?? [],
};

function writeSitting() {
  writeFileSync(join(sittingDir, 'sitting.json'), `${JSON.stringify(sitting, null, 2)}\n`);
}
writeSitting();

// A step's own output JSON (written via --out) is the resume signal for a measured step; a
// functional step with no --out (npm test, the live suite) resumes off its own last recorded status.
function alreadyDone(step) {
  if (!resuming) return false;
  if (step.out) return existsSync(join(sittingDir, `${step.id}.json`));
  return sitting.steps[step.id]?.status === 'ok';
}

// Whichever column is measured first reads high on cache-sensitive rows, so sitting.json records
// the order compare.mjs actually spawned.
function recordColumnOrder(stepId) {
  const outPath = join(sittingDir, `${stepId}.json`);
  if (!existsSync(outPath)) return;
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  if (Array.isArray(out.versions)) sitting.steps[stepId] = { ...sitting.steps[stepId], column_order: out.versions };
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

const blockedStages = [];
for (const stage of STAGES) {
  if (blockedStages.length > 0) break;
  console.log(`\n===== ${stage.label} =====`);

  const owedSteps = stage.steps.filter((step) => owedFor(step, owed) && !alreadyDone(step));
  const needsQuiet = owedSteps.some((step) => step.quiet);
  if (needsQuiet) {
    const load1 = await waitForQuiet(stage.label);
    if (load1 !== null) {
      console.error(`BLOCKED entering ${stage.label} after waiting ${QUIET_WAIT_MS / 60_000} minutes for the machine to settle`);
      for (const step of owedSteps) sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'blocked', timeout: step.timeout, load_entry: load1 };
      blockedStages.push(stage.id);
      writeSitting();
      break;
    }
  }

  let stageFailed = false;
  for (const step of stage.steps) {
    const isOwed = owedFor(step, owed);
    if (!isOwed) {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: false, status: 'not-owed' };
      continue;
    }
    if (alreadyDone(step)) {
      console.log(`${step.id}: already done, resuming past it`);
      sitting.steps[step.id] = { ...sitting.steps[step.id], id: step.id, owed: true, status: 'ok', resumed: true };
      continue;
    }
    const loadEntry = loadavg()[0];
    console.log(`\n----- ${step.id} -----`);
    const result = await runStep(step);
    const loadExit = loadavg()[0];
    sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, timeout: step.timeout, started: new Date(Date.now() - result.elapsedMs).toISOString(), elapsed_ms: result.elapsedMs, status: result.status, load_entry: loadEntry, load_exit: loadExit };
    recordColumnOrder(step.id);
    writeSitting();
    if (result.code === step.unavailableExit) {
      console.log(`${step.id}: owed, unmet (its prerequisite is not on this machine)`);
      sitting.steps[step.id] = { ...sitting.steps[step.id], status: 'owed-unmet' };
      writeSitting();
    } else if (result.status !== 'ok') {
      console.error(`${step.id}: ${result.status} after ${(result.elapsedMs / 1000).toFixed(1)}s`);
      stageFailed = true;
      break;
    } else {
      console.log(`${step.id}: ok in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    }
  }
  if (stageFailed) blockedStages.push(stage.id);

  // A row beyond band is re-run with the column order swapped, keeping both readings. This
  // classify pass is only a "is anything beyond band" probe; report.mjs does the real one.
  if (stage.id === 'baseline' && !stageFailed) {
    const compareJsonPath = join(sittingDir, 'compare.json');
    const reversedJsonPath = join(sittingDir, 'compare-reversed.json');
    if (existsSync(compareJsonPath) && !existsSync(reversedJsonPath)) {
      const compareJson = JSON.parse(readFileSync(compareJsonPath, 'utf8'));
      const beyondBand = classifyCompare(compareJson, null).some((c) => c.verdict === 'moved');
      if (beyondBand) {
        console.log('\na timing row moved beyond band on compare; running the reversed re-run (compare.mjs --reverse) to confirm...');
        const loadEntry = loadavg()[0];
        const result = await runStep({ id: 'compare-reversed', argv: ['node', 'benchmark/steps/compare-versions.mjs', '--reverse'], timeout: 30 * MINUTES, out: true });
        const loadExit = loadavg()[0];
        sitting.steps['compare-reversed'] = { id: 'compare-reversed', argv: ['node', 'benchmark/steps/compare-versions.mjs', '--reverse'], owed: true, elapsed_ms: result.elapsedMs, status: result.status, load_entry: loadEntry, load_exit: loadExit };
        recordColumnOrder('compare-reversed');
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

const failedSteps = Object.values(sitting.steps).filter((s) => s.status === 'failed' || s.status === 'timeout' || s.status === 'blocked');
const unmetSteps = Object.values(sitting.steps).filter((s) => s.status === 'owed-unmet');
sitting.failed_stage_reasons = failedSteps.map((s) => `${s.id}: ${s.status}`);
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
const noPrior = reportJson.classifications.filter((c) => c.verdict === 'no-prior').length;
console.log(`compared: ${reportJson.classifications.length - noPrior} row(s) against a prior, ${noPrior} with no prior (an uncompared row is not a pass)`);
console.log(`sitting: ${sittingDir}`);
console.log(`report: ${join(sittingDir, `${SITTING_REPORT}.md`)}`);
console.log(`default store for this pipeline: ${DEFAULT_STORE}; offered: ${OFFERED.join(', ')}`);

process.exit(reportJson.verdict === 'BLOCK' ? 1 : 0);
