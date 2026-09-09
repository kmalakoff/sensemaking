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
    await runWatch(loadConfig(configPath), { signal: controller.signal, onEvent: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
  } catch (err) {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exitCode = 1;
  } finally {
    completed = true;
    if (parentLossTimer) clearTimeout(parentLossTimer);
    if (process.connected) process.disconnect();
  }
}

export function startMeasuredWatcher({ pkgRoot, configPath }) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', pkgRoot, configPath], { detached: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  const events = [];
  let stdoutBuffer = '';
  let stderr = '';
  let outputBytes = 0;
  let failure = null;
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
        if (!['started', 'reconciled', 'reconcile-error'].includes(event?.type)) throw new Error(`invalid event ${JSON.stringify(event?.type)}`);
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
  child.on('error', (err) => (failure ??= new Error(`measured watcher spawn failed: ${err?.message ?? err}`)));
  child.stdin.on('error', (err) => (failure ??= new Error(`measured watcher stdin failed: ${err?.message ?? err}`)));
  const closed = new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));

  const waitFor = async (type, after, deadlineMs) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      if (failure) throw failure;
      const reconcileError = events.slice(after).find((event) => event.type === 'reconcile-error');
      if (reconcileError) throw new Error(`measured watcher reconcile failed: ${reconcileError.message}`);
      const index = events.findIndex((event, i) => i >= after && event.type === type);
      if (index >= 0) return { event: events[index], next: index + 1 };
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`measured watcher exited before ${type}: ${stderr.trim() || `exit ${child.exitCode ?? 'null'}${child.signalCode ? ` (${child.signalCode})` : ''}`}`);
      if (Date.now() >= deadline) throw new Error(`measured watcher produced no ${type} event before ${deadlineMs}ms`);
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
  };

  const close = async (graceMs) => {
    child.stdin.end();
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
    return result;
  };
  const assertRunning = () => {
    if (failure) throw failure;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`measured watcher is not running: ${stderr.trim() || `exit ${child.exitCode ?? 'null'}${child.signalCode ? ` (${child.signalCode})` : ''}`}`);
  };
  return { child, events, waitFor, assertRunning, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--child') await childMain(process.argv[3], process.argv[4]);
