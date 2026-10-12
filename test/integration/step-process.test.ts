// Real child processes through the same spawnOwned the gate and the benchmark tools use. Fixture
// commands are small Node scripts that publish the pids they start, so each case checks that the
// processes it owned are gone.
//
// Containment does not depend on the code under test. Every job and raw owner is tracked by its live
// handle from the moment it is spawned and stopped in afterEach. Every pid a fixture publishes is
// recorded with its OS identity (start time and command, test/lib/process-identity.ts) in this case's
// list and in a registry file (SENSE_TEST_PID_REGISTRY when the external watchdog supplies one). A
// published process still running after its case is signalled only if its identity still matches,
// then awaited; the case fails either way, after its own observed-cleanup assertions ran. A
// mismatched or unknown identity is reported and never signalled. Every bound is this test's own.
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { jobProblems, type OwnedJob, spawnOwned } from '../../benchmark/lib/step-process.ts';
import { killVerified, type ProcessIdentity, readIdentity } from '../lib/process-identity.ts';
import { packageRoot, scratchDir } from '../lib/tree.ts';
import { withinTest } from '../lib/watchdog.ts';

const POSIX = process.platform !== 'win32';
const LAUNCHER = join(packageRoot, 'benchmark', 'lib', 'step-process.ts');
const BOUND_MS = 15_000;
const REGISTRY = process.env.SENSE_TEST_PID_REGISTRY ?? join(scratchDir('step-process-registry'), 'pids.ndjson');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

// Polls with this test's own bound; nothing keeps polling once it returns.
async function gone(pid: number): Promise<boolean> {
  const until = Date.now() + BOUND_MS;
  while (alive(pid)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

const ownedJobs: OwnedJob[] = [];
const rawChildren: { child: ChildProcess; closed: Promise<unknown> }[] = [];
// Published fixture processes: identity read at publication, while the process is known to be ours.
const published = new Map<number, { role: string; identity: ProcessIdentity | 'gone' | 'unknown' }>();

function record(pid: number, role: string) {
  if (published.has(pid)) return;
  const identity = readIdentity(pid);
  published.set(pid, { role, identity });
  appendFileSync(REGISTRY, `${JSON.stringify({ pid, role, identity, at: new Date().toISOString() })}\n`);
}

// Owned from the moment of spawn: tracked for afterEach, output drained at once.
function owned(argv: readonly string[], options: Parameters<typeof spawnOwned>[1] = {}): OwnedJob {
  const job = spawnOwned(argv, options);
  ownedJobs.push(job);
  job.stdout.resume();
  job.stderr.resume();
  return job;
}

// A raw child (an owner process under test), tracked the same way. `closed` settles on close or on a
// spawn error.
function raw(argv: readonly string[]) {
  const child = spawn(argv[0] as string, argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolve) => {
    child.once('error', (err) => resolve({ code: null, signal: null, error: err.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stderr?.resume();
  rawChildren.push({ child, closed });
  return { child, closed };
}

// A node script that runs `pre`, starts `children` non-detached grandchildren, publishes every pid,
// then runs `body`. Readiness (the pids file) therefore follows whatever `pre` installs.
function fixture(dir: string, { pre = '', body = 'setInterval(() => {}, 1000);', children = 1 }: { pre?: string; body?: string; children?: number } = {}): string[] {
  const pids = join(dir, 'pids.json');
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    ${pre}
    const kids = [];
    for (let i = 0; i < ${children}; i++) kids.push(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }));
    fs.writeFileSync(${JSON.stringify(pids)} + '.tmp', JSON.stringify({ command: process.pid, children: kids.map((k) => k.pid) }));
    fs.renameSync(${JSON.stringify(pids)} + '.tmp', ${JSON.stringify(pids)});
    ${body}
  `;
  return [process.execPath, '-e', script];
}

async function readPids(dir: string, name = 'pids.json'): Promise<Record<string, number | number[]>> {
  const path = join(dir, name);
  const until = Date.now() + BOUND_MS;
  while (!existsSync(path)) {
    if (Date.now() >= until) throw new Error(`fixture published no ${name} within ${BOUND_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const pids: Record<string, number | number[]> = JSON.parse(readFileSync(path, 'utf8'));
  for (const [role, value] of Object.entries(pids)) for (const pid of [value].flat()) record(pid, role);
  return pids;
}

const all = (pids: Record<string, number | number[]>) => Object.values(pids).flat();

async function settle(job: OwnedJob, label: string) {
  return withinTest(label, BOUND_MS, job.result, () => job.fail(`${label} exceeded the test watchdog`));
}

async function containOwnedWork() {
  const problems: string[] = [];
  // Live handles first: the job's own release, then the raw owner through its ChildProcess.
  for (const job of ownedJobs.splice(0)) {
    job.fail('test cleanup');
    try {
      await settle(job, 'cleanup of an owned job');
    } catch (err) {
      problems.push(`owned job cleanup: ${(err as Error).message}`);
    }
  }
  for (const { child, closed } of rawChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await withinTest('cleanup of a raw owner', BOUND_MS, closed, () => undefined).catch((err) => problems.push(`raw owner cleanup: ${(err as Error).message}`));
  }
  // Independent containment of published processes, by verified identity only. Each one is awaited
  // to termination before the case ends, so scratch cleanup never races a live process.
  for (const [pid, { role, identity }] of [...published]) {
    published.delete(pid);
    if (identity === 'gone') continue;
    if (identity === 'unknown') {
      // Never signalled. Only ESRCH from signal 0 shows it is gone; a live pid, EPERM or any other
      // observation error stays a cleanup problem.
      try {
        process.kill(pid, 0);
        problems.push(`${role} ${pid}: still present, identity unknown at publication; not signalled`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') problems.push(`${role} ${pid}: identity unknown at publication and presence unobservable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); not signalled`);
      }
      continue;
    }
    const contained = await killVerified(identity, BOUND_MS);
    if (contained.outcome === 'gone-before') continue;
    problems.push(`${role} ${pid} outlived its case: ${contained.outcome}${contained.detail ? ` (${contained.detail})` : ''}`);
  }
  if (problems.length > 0) throw new Error(`containment after the case:\n${problems.join('\n')}`);
}

describe('owned jobs (step-process)', () => {
  afterEach(containOwnedWork);

  it('completes a command whose children exit first, with no residual work', async () => {
    const job = owned([process.execPath, '-e', "require('node:child_process').spawnSync(process.execPath, ['-e', '0']); console.log('done')"]);
    const result = await settle(job, 'clean completion');
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.deepEqual(result.command, { code: 0, signal: null });
    assert.equal(result.cleanup, POSIX ? 'released' : 'not-verified');
    if (POSIX) assert.deepEqual(result.residual, []);
  });

  // POSIX only: on Windows a grandchild left behind by an exited command is the acknowledged
  // unreachable case, so this fixture would knowingly orphan it there.
  (POSIX ? it : it.skip)('fails a command that exits 0 but leaves a grandchild holding its pipes, and reaps it', async () => {
    const dir = scratchDir('owned-residual');
    const job = owned(fixture(dir, { body: 'process.exit(0);' }));
    const pids = await readPids(dir);
    const result = await settle(job, 'residual reap');
    assert.deepEqual(result.command, { code: 0, signal: null });
    assert.equal(result.status, 'failed');
    assert.deepEqual(Array.isArray(result.residual) && result.residual.map((member) => member.pid), pids.children);
    assert.ok(jobProblems(result).some((problem) => problem.startsWith('processes outlived the command')));
    for (const pid of pids.children as number[]) assert.equal(await gone(pid), true, `grandchild ${pid} survived the release`);
  });

  it('records a command that cannot be spawned', async () => {
    const result = await settle(owned([join(scratchDir('owned-enoent'), 'no-such-command')]), 'spawn failure');
    assert.equal(result.status, 'failed');
    assert.match(result.error ?? '', /command spawn failed: .*ENOENT/);
  });

  it('keeps an early non-zero exit and a signal death as the command outcome', async () => {
    const exited = await settle(owned([process.execPath, '-e', 'process.exit(3)']), 'early exit');
    assert.equal(exited.status, 'failed');
    assert.deepEqual(exited.command, { code: 3, signal: null });
    if (POSIX) {
      const killed = await settle(owned([process.execPath, '-e', "process.kill(process.pid, 'SIGKILL')"]), 'self kill');
      assert.deepEqual(killed.command, { code: null, signal: 'SIGKILL' });
      const aborted = await settle(owned([process.execPath, '-e', 'process.abort()']), 'abort');
      assert.deepEqual(aborted.command, { code: null, signal: 'SIGABRT' });
    }
  });

  it('cancels before the leader is ready without ever starting the command', async () => {
    const dir = scratchDir('owned-cancel-before-ready');
    const job = owned(fixture(dir));
    job.cancel('SIGINT');
    const result = await settle(job, 'cancel before ready');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.command, 'not-started');
    assert.equal(result.cancel_signal, 'SIGINT');
    assert.equal(existsSync(join(dir, 'pids.json')), false, 'the command must not have run');
  });

  it('cancels right after the command starts, releasing it', async () => {
    const dir = scratchDir('owned-cancel-started');
    // Childless, so nothing it could start goes unrecorded; descendants are the working case below.
    const job = owned(fixture(dir, { children: 0 }));
    const until = Date.now() + BOUND_MS;
    while (job.commandPid === null && job.exited === null && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    const commandPid = job.commandPid;
    assert.ok(commandPid, 'the command had started');
    record(commandPid, 'command');
    job.cancel('SIGTERM');
    const result = await settle(job, 'cancel after start');
    assert.equal(result.status, 'cancelled');
    assert.equal(await gone(commandPid), true, 'the just-started command survived cancellation');
  });

  it('cancels while the command works, releasing every owned process', async () => {
    const dir = scratchDir('owned-cancel-working');
    const job = owned(fixture(dir, { children: 2 }));
    const pids = await readPids(dir);
    job.cancel('SIGTERM');
    const result = await settle(job, 'cancel during work');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.cancel_signal, 'SIGTERM');
    // Windows taskkill can report the command's exit before the leader exits; POSIX kills them together.
    if (POSIX || typeof result.command !== 'object') assert.equal(result.command, 'unknown', JSON.stringify(result));
    else assert.deepEqual(result.command, { code: 1, signal: null }, JSON.stringify(result));
    assert.equal(result.cleanup, POSIX ? 'released' : 'not-verified');
    // A command still at work when cancellation starts has not outlived itself: no problem is reported.
    assert.deepEqual(jobProblems(result), []);
    assert.equal(result.residual, POSIX ? 'command-running' : 'unsupported');
    for (const pid of all(pids)) assert.equal(await gone(pid), true, `${pid} survived cancellation`);
  });

  it('does not wait out a command that traps SIGTERM: cancellation is forced', async () => {
    const dir = scratchDir('owned-cancel-trap');
    // The trap is installed before the pids are published, so readiness proves it is in place.
    const job = owned(fixture(dir, { pre: "process.on('SIGTERM', () => {});" }));
    const pids = await readPids(dir);
    job.cancel('SIGTERM');
    const result = await settle(job, 'cancel trapped');
    assert.equal(result.status, 'cancelled');
    for (const pid of all(pids)) assert.equal(await gone(pid), true, `${pid} survived forced cancellation`);
  });

  it('lets a slow cooperative drain finish: no timer races the close', async () => {
    // Drains for 1.5 s after stdin EOF, longer than the former 1 s parent-loss grace.
    const job = owned([process.execPath, '-e', "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(0), 1500));"], { stdin: 'pipe' });
    job.stdin?.end();
    const result = await settle(job, 'slow drain');
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.deepEqual(result.command, { code: 0, signal: null });
  });

  it('fails the job on an invalid relayed message and keeps the primary and cleanup outcomes', async () => {
    const job = owned([process.execPath, '-e', "process.send({ type: 'unexpected' }); setInterval(() => {}, 1000);"], { ipc: true });
    job.onMessage((message) => job.fail(`invalid worker message ${JSON.stringify(message)}`));
    const result = await settle(job, 'invalid message');
    assert.equal(result.status, 'failed');
    assert.match(jobProblems(result)[0] ?? '', /invalid worker message/);
    assert.equal(result.cleanup, POSIX ? 'released' : 'not-verified');
  });

  (POSIX ? it : it.skip)('releases a job, its leader and a nested job with its leader when the owner is killed outright', async () => {
    const dir = scratchDir('owned-owner-sigkill');
    // The owner is the standalone launcher. Its command (the outer command) publishes its own pid, its
    // leader's pid (its parent) and the nested job's leader pid, then the nested fixture publishes its own.
    const nested = fixture(dir);
    const outer = `import(${JSON.stringify(LAUNCHER)}).then(({ spawnOwned }) => {
      const job = spawnOwned(${JSON.stringify(nested)}); job.stdout.resume(); job.stderr.resume();
      require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'outer.json'))}, JSON.stringify({ outerCommand: process.pid, outerLeader: process.ppid, innerLeader: job.leader.pid }));
    });`;
    const owner = raw([process.execPath, LAUNCHER, '--', process.execPath, '--input-type=commonjs', '-e', outer]);
    const outerPids = await readPids(dir, 'outer.json');
    const innerPids = await readPids(dir);
    owner.child.kill('SIGKILL');
    await withinTest('owner reap', BOUND_MS, owner.closed, () => undefined);
    for (const pid of [...all(outerPids), ...all(innerPids)]) assert.equal(await gone(pid), true, `${pid} survived its owner's death`);
  });

  (POSIX ? it : it.skip)('cancels through the standalone launcher on SIGTERM from a non-terminal parent', async () => {
    const dir = scratchDir('owned-launcher-sigterm');
    const launcher = raw([process.execPath, LAUNCHER, '--', ...fixture(dir)]);
    const pids = await readPids(dir);
    launcher.child.kill('SIGTERM');
    assert.deepEqual(await withinTest('launcher exit', BOUND_MS, launcher.closed, () => launcher.child.kill('SIGKILL')), { code: 130, signal: null });
    for (const pid of all(pids)) assert.equal(await gone(pid), true, `${pid} survived launcher cancellation`);
  });
});
