// One owned job: a LEADER process that leads its own process group and anchors it, and a COMMAND
// that runs inside that group with everything it starts (CLI, npm install and its scripts, the
// test runner). The owner never signals the group. It asks the live leader to release it, and the
// leader, still alive and so still owning the group id, kills its own group, itself included.
//
//   owner ── spawn(detached, ipc) ──> LEADER (group leader, anchor)
//                                       └─ spawn(not detached) ──> COMMAND and its descendants
//
// Protocol (IPC): leader→owner `ready`; owner→leader `go` {argv, cwd, env, ipc}; leader→owner
// `command-exit` {code, signal} or `spawn-error`; owner→leader `release`; leader→owner `released`
// {residual, error}, then the leader kills its own group. `relay` carries the command's own IPC
// both ways when the job asked for it; a relay that fails comes back as `relay-error`. A leader
// whose owner disconnects releases at once, without reporting.
//
// Settlement: the command's exit (or spawn error) is observed first, the group is released while
// the anchor lives, then the leader's exit, then the close of stdout/stderr. A descendant holding an
// inherited pipe dies in the release, so the pipes then close. When the anchor is lost (the leader
// died without releasing), nothing is signalled: the owner closes its own pipe ends, records the
// cleanup as unresolved, and never claims the group was reaped.
//
// No elapsed time decides anything here.
//
// Platform: POSIX process groups. Windows has no process groups: the leader's release there is
// `taskkill /T /F` of the command while the command is still running, a forced stop of the live tree
// only. Once the command has exited its descendants can't be reached. Either way the record says
// `cleanup: 'not-verified'`, never `released`; a failed taskkill is a cleanup error. No residual
// diagnostics are taken on Windows, so the orphan guarantee does not hold there.
//
// Standalone: `node benchmark/lib/step-process.ts -- <command> [args...]` runs one command as an owned
// job; SIGINT or SIGTERM to that process cancels it.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const LEADER_FILE = fileURLToPath(import.meta.url);
const WINDOWS = platform() === 'win32';

export interface GroupMember {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

export type CommandOutcome = { code: number | null; signal: NodeJS.Signals | null } | 'not-started' | 'unknown';

export interface JobResult {
  status: 'ok' | 'failed' | 'cancelled';
  command: CommandOutcome;
  // released: the live leader killed its group. not-verified: Windows (no process groups).
  // unresolved: the anchor was lost or the release never confirmed; members may still be running.
  cleanup: 'released' | 'not-verified' | 'unresolved';
  // members of the group other than the leader when it was released after the command exited: work
  // that outlived the command. command-running: the release stopped a command still at work (cancel or
  // a local stop), so its live members are that work, not leftovers.
  residual: GroupMember[] | 'command-running' | 'unsupported' | 'unknown';
  error: string | null;
  cleanup_error: string | null;
  cancel_signal: NodeJS.Signals | null;
  elapsed_ms: number;
}

export interface OwnedJobOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  // pipe: the owner writes the command's stdin (the measured watcher's EOF protocol). inherit: the
  // owner's own stdin (the standalone launcher). Otherwise ignored.
  stdin?: 'pipe' | 'ignore' | 'inherit';
  // the command gets its own IPC channel, relayed through the leader
  ipc?: boolean;
}

export interface OwnedJob {
  readonly leader: ChildProcess;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly result: Promise<JobResult>;
  // the command's own pid once the leader confirmed it started; null before that. Only for a caller
  // that must signal the command itself (an interrupt test), and only while `exited` is null.
  readonly commandPid: number | null;
  // the command's exit once the leader reported it; null while it runs or before it started
  readonly exited: { code: number | null; signal: NodeJS.Signals | null } | null;
  // the command was started and has not exited, and the leader still answers
  readonly running: boolean;
  // relay a message to the command's IPC channel. Before the command starts it is queued. False when
  // the job has no channel or can no longer deliver; a delivery that fails later fails the job.
  send(message: unknown): boolean;
  onMessage(listener: (message: unknown) => void): void;
  // explicit cancellation: forced, records `cancelled`, settles `result`
  cancel(signal: NodeJS.Signals): void;
  // a local stop by the owner (output over its cap, a protocol violation): forced, records `failed`
  fail(reason: string): void;
}

// Every problem a settled job reports, primary and cleanup alike, so none hides another.
export function jobProblems(result: JobResult, primary: string | null = null): string[] {
  const residual = Array.isArray(result.residual) && result.residual.length > 0 ? `processes outlived the command: ${result.residual.map((m) => `${m.pid} ${m.stat} ${m.command}`).join('; ')}` : null;
  return [...new Set([primary, result.error, result.cleanup_error, residual].filter((problem): problem is string => Boolean(problem)))];
}

type LeaderMessage =
  | { type: 'ready' }
  | { type: 'started'; pid: number }
  | { type: 'command-exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'spawn-error'; message: string }
  | { type: 'released'; residual: GroupMember[] | 'command-running' | 'unsupported'; cleanup: 'released' | 'not-verified'; error: string | null }
  | { type: 'relay'; message: unknown }
  | { type: 'relay-error'; message: string };

type Phase = 'starting' | 'running' | 'releasing' | 'released' | 'disconnected' | 'anchor-lost';

export function spawnOwned(argv: readonly string[], options: OwnedJobOptions = {}): OwnedJob {
  if (argv.length === 0) throw new Error('spawnOwned needs a command');
  const started = Date.now();
  const leader = spawn(process.execPath, [LEADER_FILE, '--leader'], { cwd: options.cwd, env: options.env, detached: true, stdio: [options.stdin ?? 'ignore', 'pipe', 'pipe', 'ipc'] });
  const stdout = leader.stdout as Readable;
  const stderr = leader.stderr as Readable;
  // Registered at spawn, so no terminal event is missed.
  const stdoutClosed = new Promise<void>((resolveClose) => stdout.once('close', () => resolveClose()));
  const stderrClosed = new Promise<void>((resolveClose) => stderr.once('close', () => resolveClose()));
  const listeners: ((message: unknown) => void)[] = [];
  // messages for the command sent before it exists; delivered in order right after `go`
  const queued: unknown[] = [];

  let phase: Phase = 'starting';
  let command: CommandOutcome = 'not-started';
  let cleanup: JobResult['cleanup'] = 'unresolved';
  let residual: JobResult['residual'] = 'unknown';
  let error: string | null = null;
  let cleanupError: string | null = null;
  let cancelSignal: NodeJS.Signals | null = null;
  let commandPid: number | null = null;
  const noteError = (message: string) => {
    error ??= message;
  };

  // The channel is gone or unusable while the leader may be alive: closing it from this side makes
  // the leader take its disconnect path, which releases its group without reporting.
  const dropChannel = (reason: string) => {
    if (phase === 'released' || phase === 'anchor-lost' || phase === 'disconnected') return;
    noteError(reason);
    if (phase === 'starting') {
      leader.kill('SIGKILL');
      return;
    }
    phase = 'disconnected';
    if (leader.connected) leader.disconnect();
  };
  const sendToLeader = (message: unknown) => {
    if (!leader.connected) return dropChannel(`leader channel closed before ${(message as { type: string }).type}`);
    try {
      leader.send(message as never, (err) => {
        if (err) dropChannel(`leader IPC ${(message as { type: string }).type} failed: ${err.message}`);
      });
    } catch (err) {
      dropChannel(`leader IPC ${(message as { type: string }).type} failed: ${(err as Error).message}`);
    }
  };

  const release = () => {
    if (phase === 'starting') return void leader.kill('SIGKILL');
    if (phase !== 'running') return;
    phase = 'releasing';
    sendToLeader({ type: 'release' });
  };

  leader.on('message', (message: LeaderMessage) => {
    switch (message?.type) {
      case 'ready':
        if (phase !== 'starting') return;
        if (cancelSignal || error) return void leader.kill('SIGKILL');
        phase = 'running';
        // From `go` on the command may exist, so its outcome is unknown until the leader reports it.
        command = 'unknown';
        sendToLeader({ type: 'go', argv, cwd: options.cwd, env: options.env, ipc: options.ipc === true });
        for (const queuedMessage of queued.splice(0)) sendToLeader({ type: 'relay', message: queuedMessage });
        return;
      case 'started':
        commandPid = message.pid;
        return;
      case 'command-exit':
        command = { code: message.code, signal: message.signal };
        return release();
      case 'spawn-error':
        noteError(`command spawn failed: ${message.message}`);
        return release();
      case 'released':
        phase = 'released';
        cleanup = message.cleanup;
        residual = message.residual;
        if (message.error) cleanupError ??= message.error;
        return;
      case 'relay-error':
        noteError(`command IPC relay failed: ${message.message}`);
        return release();
      case 'relay':
        for (const listener of listeners) listener(message.message);
        return;
      default:
        noteError(`leader sent an invalid message: ${JSON.stringify(message)}`);
        return release();
    }
  });
  // A leader that never spawned emits `error` with no `exit`; any later error is a channel failure.
  // The leader's own stderr, kept (bounded) so a leader that dies before `ready` is explained by its
  // original output. Callers still receive every chunk.
  let leaderStderr = '';
  stderr.on('data', (chunk: Buffer) => {
    if (phase === 'starting') leaderStderr = (leaderStderr + chunk.toString()).slice(-4096);
  });
  // A leader that never spawned emits `error` with no `exit`; any later error is a channel failure.
  const leaderGone = new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>((resolveGone) => {
    leader.on('error', (err) => {
      if (leader.pid === undefined) return resolveGone({ code: null, signal: null, spawnError: err.message });
      dropChannel(`leader: ${err.message}`);
    });
    leader.once('exit', (code, signal) => resolveGone({ code, signal, spawnError: null }));
  });

  // Members may still hold the pipes when cleanup is not confirmed; close this side, don't wait on them.
  const unresolved = (reason: string) => {
    phase = 'anchor-lost';
    cleanup = 'unresolved';
    cleanupError ??= reason;
    stdout.destroy();
    stderr.destroy();
  };
  const exitText = (gone: { code: number | null; signal: NodeJS.Signals | null }) => gone.signal ?? `exit ${gone.code}`;

  const result = (async (): Promise<JobResult> => {
    const gone = await leaderGone;
    if (gone.spawnError !== null) {
      noteError(`leader spawn failed: ${gone.spawnError}`);
      cleanup = 'released';
      stdout.destroy();
      stderr.destroy();
    } else if (phase === 'starting') {
      // Stopped, or died, before `go`: no command was ever started, so the group held only the leader.
      if (!cancelSignal && !error) noteError(`leader exited before ready (${exitText(gone)}): ${leaderStderr.trim() || 'no stderr'}`);
      cleanup = 'released';
      residual = [];
    } else if (phase === 'released') {
      // The leader reported, then killed its own group: on POSIX it must have died by that SIGKILL.
      // Any other exit means the group kill did not happen as reported.
      const expected = WINDOWS ? gone.signal === null && gone.code === 0 : gone.signal === 'SIGKILL';
      if (!expected) unresolved(`leader reported its release but exited ${exitText(gone)}, not by its own group kill; remaining members, if any, may still be running`);
    } else {
      // No report, so nothing proves the group was killed: a disconnected leader's SIGKILL can't be told
      // apart from an external kill.
      unresolved(`leader exited without confirming its release (${exitText(gone)}); remaining members, if any, were not signalled by this owner and may still be running`);
    }
    if (options.stdin === 'pipe' && leader.stdin && !leader.stdin.destroyed) leader.stdin.destroy();
    await Promise.all([stdoutClosed, stderrClosed]);
    // Assigned in event handlers, so read through its declared type rather than the narrowed initial value.
    const outcome = command as CommandOutcome;
    const commandOk = typeof outcome === 'object' && outcome.code === 0 && outcome.signal === null;
    const leftWork = Array.isArray(residual) && residual.length > 0;
    // Windows (`not-verified`) is judged on the command and the taskkill outcome alone, and the record
    // says its descendant cleanup is unverified; Windows support policy is the owner's open decision.
    const status: JobResult['status'] = cancelSignal ? 'cancelled' : commandOk && !error && !cleanupError && !leftWork && cleanup !== 'unresolved' ? 'ok' : 'failed';
    return { status, command: outcome, cleanup, residual, error, cleanup_error: cleanupError, cancel_signal: cancelSignal, elapsed_ms: Date.now() - started };
  })();

  return {
    leader,
    stdin: leader.stdin,
    stdout,
    stderr,
    result,
    get commandPid() {
      return commandPid;
    },
    get exited() {
      return typeof command === 'object' ? command : null;
    },
    get running() {
      return phase === 'running' && typeof command !== 'object' && leader.connected;
    },
    send(message) {
      if (!options.ipc || cancelSignal || error) return false;
      if (phase === 'starting') {
        queued.push(message);
        return true;
      }
      if (phase !== 'running' || !leader.connected) return false;
      sendToLeader({ type: 'relay', message });
      return true;
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    cancel(signal) {
      if (cancelSignal) return;
      cancelSignal = signal;
      // Before `go` no command exists and the leader may not lead its group yet, so it is stopped
      // through its own handle. After `go` the command may exist: release through the anchor.
      release();
    },
    fail(reason) {
      noteError(reason);
      release();
    },
  };
}

// The leader's group, read while the leader is alive, so the group id is still its own. `ps -A -o`
// with these fields is POSIX; `-g` is not used (it means different things on macOS and Linux).
function groupMembers(excluded: ReadonlySet<number>): GroupMember[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,ppid=,stat=,command='], { encoding: 'utf8' });
  if (listed.error || listed.status !== 0) throw new Error(`ps failed: ${listed.error?.message ?? (listed.stderr?.trim() || `exit ${listed.status}`)}`);
  const skip = new Set(excluded);
  if (listed.pid) skip.add(listed.pid);
  const members: GroupMember[] = [];
  for (const line of listed.stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match || Number(match[2]) !== process.pid || skip.has(Number(match[1]))) continue;
    members.push({ pid: Number(match[1]), ppid: Number(match[3]), stat: match[4] as string, command: match[5] as string });
  }
  return members;
}

function leaderMain() {
  const rawSend = process.send?.bind(process);
  if (!rawSend) throw new Error('step-process leader requires an IPC owner');
  // Every send is checked. A failed send means the owner can no longer hear this leader, so the
  // leader releases its own group (the same path as a disconnect); `done` runs either way.
  let releaseOnFailure = () => {};
  const send = (message: unknown, done?: () => void) => {
    if (!process.connected) {
      done?.();
      return releaseOnFailure();
    }
    try {
      rawSend(message as never, (err: Error | null) => {
        done?.();
        if (err) releaseOnFailure();
      });
    } catch {
      done?.();
      releaseOnFailure();
    }
  };
  let command: ChildProcess | null = null;
  let commandExited = false;
  let released = false;

  // Windows: stop the command's live tree only while the command still runs; after it exited its pid
  // may belong to another process, so nothing is signalled and cleanup is not verified.
  const windowsRelease = (): { cleanup: 'released' | 'not-verified'; error: string | null } => {
    if (!command?.pid || commandExited) return { cleanup: 'not-verified', error: null };
    const killed = spawnSync('taskkill', ['/pid', String(command.pid), '/t', '/f'], { encoding: 'utf8' });
    if (killed.error || killed.status !== 0) return { cleanup: 'not-verified', error: `taskkill failed: ${killed.error?.message ?? (killed.stderr?.trim() || `exit ${killed.status}`)}` };
    return { cleanup: 'not-verified', error: null };
  };
  const killOwnGroup = () => {
    if (WINDOWS) process.exit(0);
    process.kill(-process.pid, 'SIGKILL');
  };
  const releaseGroup = (report: boolean) => {
    if (released) return;
    released = true;
    let residual: GroupMember[] | 'command-running' | 'unsupported' = 'unsupported';
    let cleanup: 'released' | 'not-verified' = 'released';
    let error: string | null = null;
    if (WINDOWS) ({ cleanup, error } = windowsRelease());
    // Leftover work only means something once the command has exited.
    else if (command && !commandExited) residual = 'command-running';
    else {
      try {
        residual = groupMembers(new Set([process.pid]));
      } catch (err) {
        error = `residual diagnostics: ${(err as Error).message}`;
      }
    }
    if (!report || !process.connected) return killOwnGroup();
    send({ type: 'released', residual, cleanup, error }, () => killOwnGroup());
  };

  releaseOnFailure = () => releaseGroup(false);
  // Registered before anything else and checked once, so an owner already gone is not missed.
  process.on('disconnect', () => releaseGroup(false));
  if (!process.connected) return releaseGroup(false);

  process.on('message', (message: { type?: string; argv?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; ipc?: boolean; message?: unknown }) => {
    if (message?.type === 'go' && !command && message.argv) {
      const [file, ...args] = message.argv;
      command = spawn(file as string, args, { cwd: message.cwd, env: message.env, stdio: ['inherit', 'inherit', 'inherit', ...(message.ipc ? (['ipc'] as const) : [])] });
      command.on('error', (err) => {
        if (command?.pid === undefined) commandExited = true;
        send({ type: 'spawn-error', message: err.message });
      });
      command.on('exit', (code, signal) => {
        commandExited = true;
        send({ type: 'command-exit', code, signal });
      });
      if (message.ipc) command.on('message', (relayed) => send({ type: 'relay', message: relayed }));
      if (command.pid !== undefined) send({ type: 'started', pid: command.pid });
      return;
    }
    if (message?.type === 'relay') {
      if (!command?.connected) return void send({ type: 'relay-error', message: 'command IPC channel is closed' });
      try {
        command.send(message.message as never, (err) => {
          if (err) send({ type: 'relay-error', message: err.message });
        });
      } catch (err) {
        send({ type: 'relay-error', message: (err as Error).message });
      }
      return;
    }
    if (message?.type === 'release') releaseGroup(true);
  });
  send({ type: 'ready' });
}

// Standalone launcher: one command as an owned job, cancelled by SIGINT or SIGTERM to this process.
async function launcherMain(argv: string[]) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {} });
  if (positionals.length === 0) {
    console.error('usage: node benchmark/lib/step-process.ts -- <command> [args...]');
    process.exit(2);
  }
  const job = spawnOwned(positionals, { cwd: process.cwd(), env: process.env, stdin: 'inherit' });
  job.stdout.pipe(process.stdout);
  job.stderr.pipe(process.stderr);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => job.cancel(signal));
  const result = await job.result;
  if (result.status !== 'ok') console.error(`step-process: ${JSON.stringify(result)}`);
  if (result.status === 'cancelled') process.exit(130);
  if (result.status === 'ok') process.exit(0);
  process.exit(typeof result.command === 'object' && result.command.code ? result.command.code : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--leader') leaderMain();
  else await launcherMain(process.argv.slice(2));
}
