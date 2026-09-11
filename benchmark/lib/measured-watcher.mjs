import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signalProcessTree } from './native-observer.mjs';

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

async function childMain(pkgRoot, configPath) {
  const controller = new AbortController();
  let completed = false;
  let parentLossTimer = null;
  process.once('disconnect', () => {
    if (completed) return;
    process.stderr.write('measured watcher lost its supervisor; result invalid\n');
    process.exitCode = 70;
    controller.abort();
    parentLossTimer = setTimeout(() => process.exit(70), 1000);
  });
  try {
    const publicUrl = pathToFileURL(resolve(pkgRoot, 'dist', 'esm', 'index.js')).href;
    const { loadConfig, runWatch } = await import(publicUrl);
    if (typeof loadConfig !== 'function' || typeof runWatch !== 'function') throw new Error(`${publicUrl} has no public loadConfig/runWatch exports`);
    process.stdin.resume();
    process.stdin.on('end', () => controller.abort());
    const command = await new Promise((resolveCommand, rejectCommand) => {
      const cleanup = () => {
        process.off('message', onMessage);
        process.stdin.off('end', onEnd);
        process.off('disconnect', onDisconnect);
      };
      const onMessage = (message) => {
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
      process.send({ type: 'watch-child-ready' }, (err) => {
        if (!err) return;
        cleanup();
        rejectCommand(err);
      });
    });
    if (command.type === 'stop') return;
    let watchRejected = false;
    let watchError;
    try {
      await runWatch(loadConfig(configPath), { force: command.force === true, signal: controller.signal, onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
    } catch (err) {
      watchRejected = true;
      watchError = err;
    }
    if (watchRejected) {
      const event = { type: 'run-watch-rejected', error: { name: watchError?.name ?? 'Error', code: watchError?.code ?? null, message: watchError?.message ?? String(watchError) } };
      await new Promise((resolveWrite, rejectWrite) => process.stdout.write(`${JSON.stringify(event)}\n`, (err) => (err ? rejectWrite(err) : resolveWrite())));
    }
  } catch (err) {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  } finally {
    completed = true;
    if (parentLossTimer) clearTimeout(parentLossTimer);
    if (process.connected) process.disconnect();
  }
}

export function startMeasuredWatcher({ pkgRoot, configPath, force = false, deferred = false }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', pkgRoot, configPath], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const events = [];
  let stdoutBuffer = '';
  let stderr = '';
  let outputBytes = 0;
  let failure = null;
  let childReady = false;
  let startSent = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      failure ??= new Error(`measured watcher exceeded ${MAX_OUTPUT_BYTES} output bytes`);
      return;
    }
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const event = JSON.parse(line);
        if (!['started', 'reconciled', 'reconcile-error', 'run-watch-rejected'].includes(event?.type)) throw new Error(`invalid event ${JSON.stringify(event?.type)}`);
        events.push(event);
      } catch (err) {
        failure ??= new Error(`measured watcher returned malformed event: ${err?.message ?? err}`);
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_OUTPUT_BYTES) stderr += chunk;
    else failure ??= new Error(`measured watcher exceeded ${MAX_OUTPUT_BYTES} output bytes`);
  });
  child.on('message', (message) => {
    if (message?.type !== 'watch-child-ready' || childReady) return;
    childReady = true;
    resolveReady();
  });
  child.on('error', (err) => {
    failure ??= new Error(`measured watcher spawn failed: ${err?.message ?? err}`);
    rejectReady(failure);
  });
  child.stdin.on('error', (err) => (failure ??= new Error(`measured watcher stdin failed: ${err?.message ?? err}`)));
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
  child.once('close', (code, signal) => {
    if (!childReady) rejectReady(new Error(`measured watcher exited before ready: ${stderr.trim() || `exit ${code ?? 'null'}${signal ? ` (${signal})` : ''}`}`));
  });

  const start = async () => {
    await ready;
    if (startSent) return;
    if (child.exitCode !== null || child.signalCode !== null || !child.connected) throw new Error('measured watcher closed before start');
    startSent = true;
    await new Promise((resolveSend, rejectSend) => {
      child.send({ type: 'start', force }, (err) => (err ? rejectSend(new Error(`measured watcher start transport failed: ${err.message}`, { cause: err })) : resolveSend()));
    });
  };
  if (!deferred) void start().catch((err) => (failure ??= err));

  const waitForAny = async (types, after, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (failure) throw failure;
      const reconcileError = events.slice(after).find((event) => event.type === 'reconcile-error');
      if (reconcileError) throw new Error(`measured watcher reconcile failed: ${reconcileError.message}`);
      const watchError = events.slice(after).find((event) => event.type === 'run-watch-rejected');
      if (watchError && !types.includes('run-watch-rejected')) throw new Error(`runWatch rejected: ${watchError.error?.message ?? 'unknown error'}`);
      const index = events.findIndex((event, i) => i >= after && types.includes(event.type));
      if (index >= 0) return { event: events[index], next: index + 1 };
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`measured watcher exited before ${types.join(' or ')}: ${stderr.trim() || `exit ${child.exitCode ?? 'null'}${child.signalCode ? ` (${child.signalCode})` : ''}`}`);
      if (Date.now() >= deadline) throw new Error(`measured watcher produced no ${types.join(' or ')} event before ${deadlineMs}ms`);
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
  };
  const waitFor = (type, after, deadlineMs) => waitForAny([type], after, deadlineMs);

  /** @param {string | null} [expectedErrorCode] */
  const close = async (graceMs, expectedErrorCode = null) => {
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    let forced = false;
    let timer;
    const grace = new Promise((resolveGrace) => {
      timer = setTimeout(() => resolveGrace(null), graceMs);
    });
    let result = await Promise.race([closed, grace]);
    clearTimeout(timer);
    if (!result) {
      forced = true;
      signalProcessTree(child, 'SIGKILL');
      result = await closed;
    }
    if (failure) throw failure;
    if (forced) throw new Error(`measured watcher did not stop on stdin EOF within ${graceMs}ms; forced process-tree cleanup reaped ${result.signal ?? result.code}; stderr=${stderr.trim() || 'none'}`);
    if (result.code !== 0 || result.signal !== null) throw new Error(`measured watcher closed abnormally: ${JSON.stringify(result)}: ${stderr.trim() || 'no stderr'}`);
    const rejection = events.find((event) => event.type === 'run-watch-rejected');
    if (!expectedErrorCode && rejection) throw new Error(`runWatch rejected: ${rejection.error?.message ?? 'unknown error'}`);
    if (expectedErrorCode && rejection?.error?.code !== expectedErrorCode) throw new Error(`runWatch rejected with ${rejection?.error?.code ?? 'no error'}, expected ${expectedErrorCode}`);
    return { ...result, stderr };
  };
  const assertRunning = () => {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`measured watcher is not running: ${stderr.trim() || `exit ${child.exitCode ?? 'null'}${child.signalCode ? ` (${child.signalCode})` : ''}`}`);
  };
  return { child, closed, events, ready, start, waitFor, waitForAny, assertRunning, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--child') await childMain(process.argv[3], process.argv[4]);
