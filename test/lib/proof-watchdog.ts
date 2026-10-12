// External watchdog for the real-process proof of benchmark/lib/step-process.ts. The supervisor under
// test cannot be its own containment, so this runs the test command and contains what it leaves,
// using only the OS and the test's pid registry:
//
//   node test/lib/proof-watchdog.ts --bound-ms <ms> [--registry <file>] -- <command> [args...]
//
// - Without --registry the watchdog only bounds the run and contains its own group; it makes no claim
//   about processes the suite publishes (suites other than step-process publish none).
// - The registry must not exist yet; the command gets it as SENSE_TEST_PID_REGISTRY. Each line is
//   {pid, role, identity: {pid, start, command} | 'gone' | 'unknown', at}, written by the test when a
//   fixture publishes a process.
// - The command runs as the leader of its own process group. That group is signalled (SIGKILL) only
//   while its leader is this watchdog's own unreaped child (no exit observed on the ChildProcess handle,
//   so its pid, and the group id, cannot have been reused) and its OS start time still equals the one
//   read at spawn. The command line is recorded as observed metadata only: npx and others rewrite it
//   by exec or process.title. Once the leader has exited the group is never signalled.
// - If the group cannot be signalled safely, the watchdog does not wait on the uncontained run: it
//   contains the registry, reports the run as uncontained, and exits 1.
// - The run is contained on SIGINT or SIGTERM to this watchdog, or when --bound-ms (the proof run's
//   own bound, test policy) elapses. Whether or not it was contained, every registry entry still
//   running afterwards is signalled only if its identity matches, then awaited; a mismatched or
//   unknown identity is reported and never signalled.
// - Exit: the command's code when it exited by itself and nothing outlived it; 124 when the bound
//   elapsed; 130 when cancelled; 1 when anything outlived the run or containment failed.
// POSIX only: Windows has no process groups and no `ps` identity here, so the watchdog refuses there.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { killVerified, type ProcessIdentity, readIdentity } from './process-identity.ts';

const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { 'bound-ms': { type: 'string' }, registry: { type: 'string' } } });
const boundMs = Number(values['bound-ms']);
if (process.platform === 'win32') fail(2, 'proof-watchdog: POSIX only (process groups and ps identity)');
if (!Number.isFinite(boundMs) || boundMs <= 0 || positionals.length === 0) fail(2, 'usage: node test/lib/proof-watchdog.ts --bound-ms <ms> [--registry <file>] -- <command> [args...]');
const registry = values.registry ? resolve(values.registry) : null;
if (registry && existsSync(registry)) fail(2, `proof-watchdog: registry ${registry} already exists; use a fresh path`);
if (registry) mkdirSync(dirname(registry), { recursive: true });

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

const run = spawn(positionals[0] as string, positionals.slice(1), { detached: true, stdio: 'inherit', env: registry ? { ...process.env, SENSE_TEST_PID_REGISTRY: registry } : process.env });
// Set in the exit handler itself, so containment can never signal the group after its leader exited.
let runExited = false;
const runExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolveExit) => {
  run.once('error', (err) => {
    runExited = true;
    resolveExit({ code: null, signal: null, error: err.message });
  });
  run.once('exit', (code, signal) => {
    runExited = true;
    resolveExit({ code, signal });
  });
});
const runIdentity = run.pid ? readIdentity(run.pid) : 'gone';

let contained: 'bound' | 'SIGINT' | 'SIGTERM' | null = null;
let uncontained = false;
let resolveUncontained: () => void = () => {};
const runUncontained = new Promise<'uncontained'>((resolveRun) => {
  resolveUncontained = () => resolveRun('uncontained');
});
const problems: string[] = [];
const refuse = (reason: string) => {
  uncontained = true;
  problems.push(`run leader ${run.pid}: ${reason}; its group was not signalled and the run is uncontained`);
  resolveUncontained();
};
const contain = (reason: 'bound' | 'SIGINT' | 'SIGTERM') => {
  if (contained) return;
  contained = reason;
  console.error(`proof-watchdog: containing the run (${reason})`);
  if (runExited || run.exitCode !== null || run.signalCode !== null) return;
  if (!run.pid) return refuse('no pid');
  if (typeof runIdentity !== 'object') return refuse(`start identity was ${runIdentity} at spawn`);
  const now = readIdentity(run.pid);
  if (typeof now !== 'object') return refuse(`start identity now ${now}`);
  if (now.start !== runIdentity.start) return refuse(`start time changed (${runIdentity.start} -> ${now.start})`);
  try {
    process.kill(-run.pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') refuse(`group signal failed: ${(err as Error).message}`);
  }
};
const timer = setTimeout(() => contain('bound'), boundMs);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => contain(signal));

const settled = await Promise.race([runExit, runUncontained]);
clearTimeout(timer);
const exit = settled === 'uncontained' ? { code: null, signal: null, error: 'run left uncontained' } : settled;
if (settled !== 'uncontained' && exit.error) problems.push(`run spawn failed: ${exit.error}`);

// Everything the test published, contained by verified identity only, each awaited to termination.
// A missing registry is not a clean run: the proof always publishes, so its absence is reported.
// A malformed line is reported and the remaining valid entries are still contained.
const entries: { pid: number; role: string; identity: ProcessIdentity | 'gone' | 'unknown' }[] = [];
if (registry && !existsSync(registry)) problems.push(`registry ${registry} was never written; no publication evidence`);
else if (registry) {
  for (const [index, line] of readFileSync(registry, 'utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!Number.isSafeInteger(entry?.pid) || typeof entry?.role !== 'string') throw new Error('missing pid or role');
      entries.push(entry);
    } catch (err) {
      problems.push(`registry line ${index + 1} is malformed (${(err as Error).message}): ${line.slice(0, 200)}`);
    }
  }
}
for (const entry of entries) {
  if (entry.identity === 'gone') continue;
  if (entry.identity === 'unknown') {
    problems.push(`${entry.role} ${entry.pid}: identity unknown at publication; not signalled`);
    continue;
  }
  const outcome = await killVerified(entry.identity, 15_000);
  if (outcome.outcome !== 'gone-before') problems.push(`${entry.role} ${entry.pid} outlived the run: ${outcome.outcome}${outcome.detail ? ` (${outcome.detail})` : ''}`);
}

console.error(`proof-watchdog: run ${JSON.stringify({ ...exit, leader_identity_at_spawn: runIdentity })}; registry ${registry ? `entries ${entries.length}` : 'not used'}; contained ${contained ?? 'no'}`);
for (const problem of problems) console.error(`proof-watchdog: ${problem}`);
if (uncontained) process.exit(1);
if (contained === 'bound') process.exit(124);
if (contained) process.exit(130);
if (problems.length > 0) process.exit(1);
process.exit(exit.code ?? 1);
