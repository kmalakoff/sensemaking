import { type ChildProcess, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore, openTreeForStore } from '../lib/stores.ts';
import { writeNote } from '../lib/tree.ts';

const SUPERVISOR = join(packageRoot, 'test', 'lib', 'benchmark-worker-supervisor.mjs');
const DEADLINE_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function workerPid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`supervisor returned invalid worker pid ${JSON.stringify(value)}`);
  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

async function waitForExit(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

function closeOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

async function beforeDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${label} timed out after ${DEADLINE_MS}ms`)), DEADLINE_MS)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForReady(child: ChildProcess, onSpawn: (pid: number) => void): Promise<number> {
  let output = '';
  let stderr = '';
  let outputBytes = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (err: unknown, pid?: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else if (pid === undefined) reject(new Error('supervisor readiness settled without a worker pid'));
      else resolve(pid);
    };
    timer = setTimeout(() => settle(new Error(`supervisor readiness timed out; stderr=${stderr || 'none'}`)), DEADLINE_MS);
    child.stderr?.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return settle(new Error(`supervisor exceeded ${MAX_OUTPUT_BYTES} output bytes`));
      stderr += chunk;
    });
    child.stdout?.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return settle(new Error(`supervisor exceeded ${MAX_OUTPUT_BYTES} output bytes`));
      output += chunk;
      try {
        for (;;) {
          const newline = output.indexOf('\n');
          if (newline < 0) break;
          const line = output.slice(0, newline);
          output = output.slice(newline + 1);
          const message = JSON.parse(line);
          const pid = workerPid(message.pid);
          if (message.state === 'spawned') onSpawn(pid);
          else if (message.state === 'ready') settle(null, pid);
          else throw new Error(`supervisor returned invalid state ${JSON.stringify(message.state)}`);
        }
      } catch (err) {
        settle(err);
      }
    });
    child.once('error', settle);
    child.once('close', (code, signal) => settle(new Error(`supervisor exited before readiness: ${signal ?? code}; stderr=${stderr || 'none'}`)));
  });
}

async function proveParentLoss(mode: 'observer' | 'watcher', configPath: string): Promise<void> {
  const supervisor = spawn(process.execPath, [SUPERVISOR, mode, packageRoot, configPath], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const supervisorClosed = closeOf(supervisor);
  let workerPid: number | null = null;
  let primaryError: unknown = null;
  try {
    workerPid = await waitForReady(supervisor, (pid) => (workerPid = pid));
    supervisor.kill('SIGKILL');
    await beforeDeadline(supervisorClosed, `${mode} supervisor reap`);
    assert.equal(await waitForExit(workerPid, DEADLINE_MS), true, `${mode} worker ${workerPid} survived its supervisor`);
  } catch (err) {
    primaryError = err;
  }

  const cleanupErrors: unknown[] = [];
  try {
    if (supervisor.exitCode === null && supervisor.signalCode === null) signalProcessTree(supervisor, 'SIGKILL');
    await beforeDeadline(supervisorClosed, `${mode} supervisor failure cleanup`);
  } catch (err) {
    cleanupErrors.push(err);
  }
  try {
    if (workerPid !== null && processExists(workerPid)) {
      signalProcessTree({ pid: workerPid, exitCode: null, signalCode: null }, 'SIGKILL');
      if (!(await waitForExit(workerPid, DEADLINE_MS))) throw new Error(`${mode} worker ${workerPid} survived forced cleanup`);
    }
  } catch (err) {
    cleanupErrors.push(err);
  }
  if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `${mode} parent-loss proof and cleanup failed`);
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${mode} cleanup failed`);
}

describe('benchmark worker parent lifetime', () => {
  it('ends observers during supervised startup and live watchers when their supervisor disappears', async () => {
    await forEachStore(async (store) => {
      const tree = scratchDir(`worker-parent-loss-${store}`);
      const configPath = join(tree, 'sense.config.json');
      writeFileSync(configPath, JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
      writeNote(tree, 'a.md', { body: `${store} worker lifetime.` });
      const opened = await openTreeForStore(store, tree);
      await opened.store.close();

      await proveParentLoss('observer', configPath);
      await proveParentLoss('watcher', configPath);
    });
  });
});
