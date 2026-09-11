import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [mode, packageRoot, configPath] = process.argv.slice(2);
const helper = mode === 'observer' ? 'native-observer.mjs' : mode === 'watcher' ? 'measured-watcher.mjs' : null;
if (!helper) throw new Error(`unknown benchmark worker ${JSON.stringify(mode)}`);

const args = [join(packageRoot, 'benchmark', 'lib', helper), '--child'];
if (mode === 'watcher') args.push(packageRoot, configPath);
const worker = spawn(process.execPath, args, { detached: true, stdio: [mode === 'watcher' ? 'pipe' : 'ignore', 'pipe', 'pipe', 'ipc'] });
process.stdout.write(`${JSON.stringify({ state: 'spawned', pid: worker.pid })}\n`);

let stdout = '';
let watcherStartSent = false;
worker.on('message', (message) => {
  if (mode === 'observer' && message?.type === 'supervised') process.stdout.write(`${JSON.stringify({ state: 'ready', pid: worker.pid })}\n`);
  if (mode !== 'watcher' || message?.type !== 'watch-child-ready' || watcherStartSent) return;
  watcherStartSent = true;
  const failStart = (err) => {
    process.stderr.write(`watcher start IPC failed: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
  };
  try {
    worker.send({ type: 'start', force: false }, (err) => {
      if (err) failStart(err);
    });
  } catch (err) {
    failStart(err);
  }
});
worker.stdout.on('data', (chunk) => {
  if (mode !== 'watcher') return;
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    const event = JSON.parse(line);
    if (event?.type === 'started') process.stdout.write(`${JSON.stringify({ state: 'ready', pid: worker.pid })}\n`);
  }
});
worker.stderr.pipe(process.stderr);
worker.on('error', (err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exitCode = 1;
});
worker.on('close', (code, signal) => {
  process.stderr.write(`${mode} worker exited before its supervisor: ${signal ?? code}\n`);
  process.exitCode = 1;
});
