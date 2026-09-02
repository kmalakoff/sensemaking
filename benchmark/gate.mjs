// Release benchmark gate: node benchmark/gate.mjs [--dry-run] [--continue] [--resume <dir>] [--allow-busy] [--paths a,b,c] [--store <name>] [--smoke]
// Runs the staged pipeline benchmark/lib/stages.mjs defines, gated by what
// benchmark/lib/gates.mjs says the diff since the last tag owes. A stage that fails stops the
// run; --continue runs every stage regardless, for diagnosis. --dry-run prints what the diff owes
// and exits without measuring. --resume <dir> reruns a sitting, skipping completed steps.
// --paths overrides the git diff with an explicit comma-separated path list, for exercising
// --dry-run against a hypothetical diff without committing anything.
// --store <name> runs one store's tree battery alone, whatever the diff owes: the diagnostic run
// for "is duckdb still slow at 26k", not a release gate.
//
// A report is always written to benchmark/reports/<date>-release-gate.{json,md} at the end
// (report.mjs), including for a blocked sitting: a report is a record of what happened. The
// verdict decides whether BENCHMARKING.md's numbers of record move, not a flag or a human call.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { owedReasons } from './lib/gates.mjs';
import { quietMachineCheck } from './lib/quiet-machine.mjs';
import { buildStages, DEFAULT_STORE, MINUTES, OFFERED, ROOT } from './lib/stages.mjs';
import { classifyCompare } from './lib/verdict.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const continueMode = argv.includes('--continue');
const allowBusy = argv.includes('--allow-busy');
// Smoke: the whole pipeline against small synthetic trees, so the gate itself can be exercised in
// minutes. Its numbers are not a sitting and the report says so.
const smoke = argv.includes('--smoke');
const STAGES = buildStages({ smoke });
const resumeIdx = argv.indexOf('--resume');
const resumeDir = resumeIdx >= 0 ? resolve(argv[resumeIdx + 1]) : null;
const pathsIdx = argv.indexOf('--paths');
const pathsOverride = pathsIdx >= 0 ? argv[pathsIdx + 1].split(',').filter(Boolean) : null;
const storeIdx = argv.indexOf('--store');
const store = storeIdx >= 0 ? argv[storeIdx + 1] : null;
if (store && !OFFERED.includes(store)) {
  console.error(`unknown store "${store}"; schema.json offers: ${OFFERED.join(', ')}`);
  process.exit(2);
}

// One store's tree battery: the battery-<store>-* steps, or for the default store the timing steps
// that measure it under their own names. Selecting a store is itself the request, so these run
// whatever the diff owes.
const STORE_BATTERY = { [DEFAULT_STORE]: ['compare', 'scale-13k', 'scale-26k', 'stress'] };
const inStoreBattery = (step) => (STORE_BATTERY[store] ?? []).includes(step.id) || step.id.startsWith(`battery-${store}-`);

function packageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? null;
}

// Paths changed since the last tag: what decides which gates are owed. Uncommitted changes count
// too (`git diff` against a ref includes the working tree), which is what "will this diff owe a
// gate if it ships" needs to answer before anything is committed. --paths substitutes a
// hypothetical path list, for testing --dry-run without a real diff.
function changedPaths() {
  if (pathsOverride) return { lastTag: '(--paths override)', paths: pathsOverride };
  const tag = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' });
  if (tag.status !== 0) throw new Error(`git describe --tags failed: ${tag.stderr}`);
  const lastTag = tag.stdout.trim();
  const diff = spawnSync('git', ['diff', '--name-only', lastTag], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16e6 });
  if (diff.status !== 0) throw new Error(`git diff --name-only ${lastTag} failed: ${diff.stderr}`);
  return { lastTag, paths: diff.stdout.split('\n').filter(Boolean) };
}

const owedFor = (step, owed) => (store ? inStoreBattery(step) : step.owedBy === 'always' || owed.has(step.owedBy));

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
      const tag = !isOwed ? 'not owed' : step.manual ? `OWED, manual (${step.manual.reason})` : 'OWED';
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

const today = new Date().toISOString().slice(0, 10);
const baselineVersion = packageVersion();
const sittingDir = resumeDir ?? join(ROOT, '.tmp', 'sittings', `${today}-${baselineVersion}`);
mkdirSync(sittingDir, { recursive: true });

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
  continue: continueMode,
  allow_busy: allowBusy,
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
  if (!resumeDir) return false;
  if (step.out) return existsSync(join(sittingDir, `${step.id}.json`));
  return sitting.steps[step.id]?.status === 'ok';
}

// Cold-crawl numbers move with filesystem cache state, so whichever column a step measures
// first tends to read high: a same-sitting A/B is necessary but not sufficient on its own. This
// records which order compare.mjs (or its --reverse) actually spawned, straight off the step's
// own --out JSON, so a reader of sitting.json can see it without opening the step JSON too.
function recordColumnOrder(stepId) {
  const outPath = join(sittingDir, `${stepId}.json`);
  if (!existsSync(outPath)) return;
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  if (Array.isArray(out.versions)) sitting.steps[stepId] = { ...sitting.steps[stepId], column_order: out.versions };
}

function runStep(step) {
  return new Promise((settle) => {
    const outPath = step.out ? join(sittingDir, `${step.id}.json`) : null;
    const argv2 = outPath ? [...step.argv, '--out', outPath] : step.argv;
    const logPath = join(sittingDir, `${step.id}.log`);
    const logStream = createWriteStream(logPath, { flags: 'w' });
    const started = Date.now();
    const child = spawn(argv2[0], argv2.slice(1), { cwd: ROOT, env: { ...process.env, ...(step.env ?? {}) }, timeout: step.timeout, killSignal: 'SIGKILL' });
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      logStream.write(d);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      logStream.write(d);
    });
    child.on('error', (err) => {
      logStream.end();
      settle({ status: 'failed', elapsedMs: Date.now() - started, detail: String(err.message ?? err) });
    });
    child.on('close', (code, signal) => {
      logStream.end();
      const elapsedMs = Date.now() - started;
      const timedOut = signal === 'SIGKILL' && elapsedMs >= step.timeout;
      settle({ status: timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed', elapsedMs, code, signal });
    });
  });
}

const blockedStages = [];
for (const stage of STAGES) {
  if (blockedStages.length > 0 && !continueMode) break;
  console.log(`\n===== ${stage.label} =====`);

  const owedSteps = stage.steps.filter((step) => owedFor(step, owed) && !step.manual && !alreadyDone(step));
  const needsQuiet = owedSteps.some((step) => step.quiet);
  if (needsQuiet) {
    const cores = cpus().length;
    const load1 = loadavg()[0];
    const { blocked, message } = quietMachineCheck(load1, cores, allowBusy);
    if (message) console.error(message);
    if (blocked) {
      console.error(`BLOCKED entering ${stage.label}`);
      for (const step of owedSteps) sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'blocked', timeout: step.timeout, load_entry: load1 };
      blockedStages.push(stage.id);
      writeSitting();
      if (!continueMode) break;
      continue;
    }
  }

  let stageFailed = false;
  for (const step of stage.steps) {
    const isOwed = owedFor(step, owed);
    if (!isOwed) {
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: false, status: 'not-owed' };
      continue;
    }
    if (step.manual) {
      console.log(`${step.id}: owed, unmet (${step.manual.reason})`);
      sitting.steps[step.id] = { id: step.id, argv: step.argv, owed: true, status: 'owed-unmet', reason: step.manual.reason };
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
      if (!continueMode) break;
    } else {
      console.log(`${step.id}: ok in ${(result.elapsedMs / 1000).toFixed(1)}s`);
    }
  }
  if (stageFailed) blockedStages.push(stage.id);

  // The remedy for a suspicious same-sitting delta (2026-08-21 methodology, PLAN.md 3.10): when
  // compare.mjs shows any wall/inproc row beyond its band, re-run it with columns and run order
  // swapped and keep both readings. classifyCompare(..., null) here is a cheap "is anything
  // beyond band yet" probe, not the final classification -- report.mjs does that once, reading
  // both files back.
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

  // The build a validated stage 0 produces is what every later version-of-record read comes
  // from; re-read after each stage rather than once, since --resume can re-enter here after a
  // rebuild.
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

// Always written, even for a blocked sitting: a report is a record of what happened.
// report.mjs classifies every row (reading this sitting's own step JSONs plus the newest prior
// report) and decides PASS/BLOCK; release.mjs only relays what it decided.
const reportResult = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'report.mjs'), '--sitting', sittingDir], { cwd: ROOT, encoding: 'utf8' });
process.stdout.write(reportResult.stdout ?? '');
process.stderr.write(reportResult.stderr ?? '');
if (reportResult.status !== 0) {
  console.error('report.mjs failed to render this sitting; see above');
  process.exit(1);
}
const reportJson = JSON.parse(readFileSync(join(ROOT, 'benchmark', 'reports', `${sitting.date}-release-gate.json`), 'utf8'));

console.log(`\n${reportJson.verdict}`);
if (reportJson.verdict === 'BLOCK') for (const reason of reportJson.verdict_reasons) console.error(`  ${reason}`);
if (unmetSteps.length > 0) console.log(`owed and unmet (not a block): ${unmetSteps.map((s) => s.id).join(', ')}`);
console.log(reportJson.verdict === 'PASS' ? 'numbers of record: updated to point at this sitting' : 'numbers of record: left as they were (BLOCK)');
console.log(`sitting: ${sittingDir}`);
console.log(`report: benchmark/reports/${sitting.date}-release-gate.md`);
console.log(`default store for this pipeline: ${DEFAULT_STORE}; offered: ${OFFERED.join(', ')}`);

process.exit(reportJson.verdict === 'BLOCK' ? 1 : 0);
