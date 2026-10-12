import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { WatchEvent } from '../../src/watch.ts';
import { type JobResult, jobProblems, spawnOwned } from './step-process.ts';

interface ControlMessage {
  type?: unknown;
  force?: unknown;
}
interface ErrorDetails {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  stack?: unknown;
}
type EventType = WatchEvent['type'] | 'run-watch-rejected';
interface RecordedEvent {
  type?: unknown;
  rootDir?: unknown;
  dbPath?: unknown;
  parsed?: unknown;
  total?: unknown;
  warnings?: unknown;
  message?: unknown;
  error?: ErrorDetails | null;
}
interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

async function childMain(pkgRoot: string, configPath: string) {
  const controller = new AbortController();
  let completed = false;
  // Losing the supervisor invalidates the result. Exit at once: the job's leader releases the group,
  // so no cleanup here is counted on, and no timer decides when to give up.
  process.once('disconnect', () => {
    if (completed) return;
    process.stderr.write('measured watcher lost its supervisor; result invalid\n');
    process.exit(70);
  });
  try {
    const publicUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'index.js')).href;
    const { loadConfig, runWatch }: typeof import('../../src/index.ts') = await import(publicUrl);
    if (typeof loadConfig !== 'function' || typeof runWatch !== 'function') throw new Error(`${publicUrl} has no public loadConfig/runWatch exports`);
    process.stdin.resume();
    process.stdin.on('end', () => controller.abort());
    const command = await new Promise<ControlMessage>((resolveCommand, rejectCommand) => {
      const cleanup = () => {
        process.off('message', onMessage);
        process.stdin.off('end', onEnd);
        process.off('disconnect', onDisconnect);
      };
      const onMessage = (message: ControlMessage | null) => {
        if (message?.type !== 'start') return;
        cleanup();
        resolveCommand(message);
      };
      const onEnd = () => {
        cleanup();
        resolveCommand({ type: 'stop' });
      };
      const onDisconnect = () => {
        cleanup();
        rejectCommand(new Error('measured watcher lost its supervisor before start'));
      };
      process.on('message', onMessage);
      process.stdin.once('end', onEnd);
      process.once('disconnect', onDisconnect);
      (process.send as NonNullable<typeof process.send>)({ type: 'watch-child-ready' }, (err) => {
        if (!err) return;
        cleanup();
        rejectCommand(err);
      });
    });
    if (command.type === 'stop') return;
    // Test-only control: exercise the registered JavaScript signal handler on every OS. This
    // does not claim to reproduce Windows OS signal delivery, where child.kill behaves differently.
    const onControl = (message: ControlMessage | null) => {
      if (message?.type === 'request-graceful-stop') process.emit('SIGINT', 'SIGINT');
    };
    process.on('message', onControl);
    try {
      let watchRejected = false;
      let watchError: unknown;
      try {
        await runWatch(loadConfig(configPath), { force: command.force === true, signal: controller.signal, onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
      } catch (err) {
        watchRejected = true;
        watchError = err;
      }
      if (watchRejected) {
        const event = { type: 'run-watch-rejected', error: { name: (watchError as ErrorDetails | null | undefined)?.name ?? 'Error', code: (watchError as ErrorDetails | null | undefined)?.code ?? null, message: (watchError as ErrorDetails | null | undefined)?.message ?? String(watchError) } };
        await new Promise<void>((resolveWrite, rejectWrite) => process.stdout.write(`${JSON.stringify(event)}\n`, (err) => (err ? rejectWrite(err) : resolveWrite())));
      }
    } finally {
      process.off('message', onControl);
    }
  } catch (err) {
    process.stderr.write(`${(err as ErrorDetails | null | undefined)?.stack ?? err}\n`);
    process.exitCode = 1;
  } finally {
    completed = true;
    if (process.connected) process.disconnect();
  }
}

// The watcher child runs as an owned job (step-process.ts): its group, npm installs included, is
// released when it exits or is stopped. Waits end on the event, an error event, or the child's exit;
// none expires. Close is the cooperative drain: stdin EOF, then the job settles.
export function startMeasuredWatcher({ pkgRoot, configPath, force = false, deferred = false }: { pkgRoot: string; configPath: string; force?: boolean; deferred?: boolean }) {
  const job = spawnOwned([process.execPath, fileURLToPath(import.meta.url), '--child', pkgRoot, configPath], { stdin: 'pipe', ipc: true });
  let settled: JobResult | null = null;
  void job.result.then((result) => {
    settled = result;
  });
  // Close was asked for: stdin is ended and a start that has not been sent never will be.
  let closing = false;
  const events: RecordedEvent[] = [];
  let stdoutBuffer = '';
  let stderr = '';
  let outputBytes = 0;
  let failure: Error | null = null;
  let childReady = false;
  let startSent = false;
  let resolveReady: () => void;
  let rejectReady: (reason?: unknown) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const describeEnd = () => {
    const end = job.exited ? `exit ${job.exited.code ?? 'null'}${job.exited.signal ? ` (${job.exited.signal})` : ''}` : settled ? `job ${settled.status}: ${jobProblems(settled).join('; ') || JSON.stringify(settled.command)}` : 'leader not running';
    return stderr.trim() || end;
  };
  const overflow = () => {
    failure ??= new Error(`measured watcher exceeded ${MAX_OUTPUT_BYTES} output bytes`);
    job.fail(failure.message);
  };
  job.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) return overflow();
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const event: RecordedEvent = JSON.parse(line);
        if (!['started', 'reconciled', 'reconcile-error', 'run-watch-rejected'].includes(event?.type as string)) throw new Error(`invalid event ${JSON.stringify(event?.type)}`);
        events.push(event);
      } catch (err) {
        failure ??= new Error(`measured watcher returned malformed event: ${(err as ErrorDetails | null | undefined)?.message ?? err}`);
      }
    }
  });
  job.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) return overflow();
    stderr += chunk;
  });
  job.onMessage((message) => {
    if ((message as ControlMessage | null)?.type !== 'watch-child-ready' || childReady) return;
    childReady = true;
    resolveReady();
  });
  job.stdin?.on('error', (err: Error) => (failure ??= new Error(`measured watcher stdin failed: ${err.message}`)));
  const closed = job.result.then((result): ChildClose & { result: JobResult } => ({ ...(typeof result.command === 'object' ? result.command : { code: null, signal: null }), result }));
  void closed.then(({ code, signal, result }) => {
    if (!childReady) rejectReady(new Error(`measured watcher exited before ready: ${result.error ?? (stderr.trim() || `exit ${code ?? 'null'}${signal ? ` (${signal})` : ''}`)}`));
  });

  const start = async () => {
    await ready;
    if (startSent || closing) return;
    if (!job.running) throw new Error('measured watcher closed before start');
    startSent = true;
    if (!job.send({ type: 'start', force })) throw new Error('measured watcher start transport failed: channel closed');
  };
  if (!deferred) void start().catch((err) => (failure ??= err));

  const waitForAny = async (types: readonly EventType[], after: number) => {
    for (;;) {
      if (failure) throw failure;
      const reconcileError = events.slice(after).find((event) => event.type === 'reconcile-error');
      if (reconcileError) throw new Error(`measured watcher reconcile failed: ${reconcileError.message}`);
      const watchError = events.slice(after).find((event) => event.type === 'run-watch-rejected');
      if (watchError && !types.includes('run-watch-rejected')) throw new Error(`runWatch rejected: ${watchError.error?.message ?? 'unknown error'}`);
      const index = events.findIndex((event, i) => i >= after && types.includes(event.type as EventType));
      if (index >= 0) return { event: events[index], next: index + 1 };
      if (job.exited || settled || (startSent && !job.running)) throw new Error(`measured watcher exited before ${types.join(' or ')}: ${describeEnd()}`);
      await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 25));
    }
  };
  const waitFor = (type: EventType, after: number) => waitForAny([type], after);

  const requestGracefulStop = async () => {
    if (!events.some((event) => event.type === 'started')) throw new Error('measured watcher cannot request a graceful stop before observing its started event');
    if (!job.running) throw new Error('measured watcher cannot request a graceful stop after its child exited or disconnected');
    if (!job.send({ type: 'request-graceful-stop' })) throw new Error('measured watcher graceful-stop transport failed: channel closed');
  };

  // The cooperative drain: stdin EOF stops runWatch, which finishes its current work; the job then
  // settles. Nothing races it.
  /** @param {string | null} [expectedErrorCode] */
  const close = async (expectedErrorCode: unknown = null) => {
    closing = true;
    // Ended in every phase: an EOF sent before the child starts reaches it at startup, which then
    // stops without running.
    if (job.stdin && !job.stdin.writableEnded) job.stdin.end();
    const { code, signal, result } = await closed;
    // The primary failure (a malformed event, an overflow) and every job outcome are reported together.
    const problems = jobProblems(result, failure ? failure.message : null);
    if (problems.length > 0) throw new Error(`measured watcher ${problems.join('; ')}; command ${JSON.stringify(result.command)}; cleanup ${result.cleanup}; stderr=${stderr.trim() || 'none'}`, failure ? { cause: failure } : undefined);
    if (code !== 0 || signal !== null) throw new Error(`measured watcher closed abnormally: ${JSON.stringify({ code, signal })}: ${stderr.trim() || 'no stderr'}`);
    const rejection = events.find((event) => event.type === 'run-watch-rejected');
    if (!expectedErrorCode && rejection) throw new Error(`runWatch rejected: ${rejection.error?.message ?? 'unknown error'}`);
    if (expectedErrorCode && rejection?.error?.code !== expectedErrorCode) throw new Error(`runWatch rejected with ${rejection?.error?.code ?? 'no error'}, expected ${expectedErrorCode}`);
    return { code, signal, stderr };
  };
  // An emergency stop (a failed test, an abandoned run): forced, never a drain; the result is invalid.
  const kill = (reason: string) => job.fail(reason);
  const assertRunning = () => {
    if (failure) throw failure;
    if (!job.running) throw new Error(`measured watcher is not running: ${describeEnd()}`);
  };
  return { job, closed, events, ready, start, waitFor, waitForAny, requestGracefulStop, assertRunning, close, kill };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--child') await childMain(process.argv[3], process.argv[4]);
