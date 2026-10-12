// A stand-in owner for one benchmark worker (native observer or measured watcher). The worker runs as
// an owned job, the way the benchmark runs it, so killing this process tests what happens to the
// worker and its group when their owner disappears. Prints the worker's and its leader's pids.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, packageRoot, configPath] = process.argv.slice(2);
const helper = mode === 'observer' ? 'native-observer.ts' : mode === 'watcher' ? 'measured-watcher.ts' : null;
if (!helper) throw new Error(`unknown benchmark worker ${JSON.stringify(mode)}`);
const { spawnOwned } = await import(pathToFileURL(join(packageRoot, 'benchmark', 'lib', 'step-process.ts')).href);

const argv = [process.execPath, join(packageRoot, 'benchmark', 'lib', helper), '--child'];
if (mode === 'watcher') argv.push(packageRoot, configPath);
const job = spawnOwned(argv, { stdin: mode === 'watcher' ? 'pipe' : 'ignore', ipc: true });

let announced = false;
const announce = (state) => {
  if (job.commandPid === null) return;
  if (!announced) process.stdout.write(`${JSON.stringify({ state: 'spawned', pid: job.commandPid, leader: job.leader.pid })}\n`);
  announced = true;
  if (state === 'ready') process.stdout.write(`${JSON.stringify({ state: 'ready', pid: job.commandPid, leader: job.leader.pid })}\n`);
};

let stdout = '';
job.onMessage((message) => {
  announce('spawned');
  if (mode === 'observer' && message?.type === 'supervised') announce('ready');
  if (mode === 'watcher' && message?.type === 'watch-child-ready' && !job.send({ type: 'start', force: false })) {
    process.stderr.write('watcher start IPC failed: channel closed\n');
    process.exitCode = 1;
    job.fail('watcher start IPC failed');
  }
});
job.stdout.on('data', (chunk) => {
  if (mode !== 'watcher') return;
  stdout += chunk;
  for (;;) {
    const newline = stdout.indexOf('\n');
    if (newline < 0) break;
    const line = stdout.slice(0, newline);
    stdout = stdout.slice(newline + 1);
    const event = JSON.parse(line);
    if (event?.type === 'started') announce('ready');
  }
});
job.stderr.pipe(process.stderr);
const result = await job.result;
process.stderr.write(`${mode} worker job ended before its supervisor: ${JSON.stringify(result)}\n`);
process.exitCode = 1;
