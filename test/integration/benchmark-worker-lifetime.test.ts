import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { type OwnedJob, spawnOwned } from '../../benchmark/lib/step-process.ts';
import { killVerified, type ProcessIdentity, readIdentity } from '../lib/process-identity.ts';
import { forEachStore, openTreeForStore } from '../lib/stores.ts';
import { packageRoot, scratchDir, writeNote } from '../lib/tree.ts';
import { withinTest } from '../lib/watchdog.ts';

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

async function waitForReady(job: OwnedJob, onSpawn: (pids: { worker: number; leader: number }) => void): Promise<{ worker: number; leader: number }> {
  let output = '';
  let stderr = '';
  let outputBytes = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err: unknown, pids?: { worker: number; leader: number }) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else if (pids === undefined) reject(new Error('supervisor readiness settled without worker pids'));
      else resolve(pids);
    };
    job.stderr.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) return settle(new Error(`supervisor exceeded ${MAX_OUTPUT_BYTES} output bytes`));
      stderr += chunk;
    });
    job.stdout.on('data', (chunk) => {
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
          const pids = { worker: workerPid(message.pid), leader: workerPid(message.leader) };
          if (message.state === 'spawned') onSpawn(pids);
          else if (message.state === 'ready') settle(null, pids);
          else throw new Error(`supervisor returned invalid state ${JSON.stringify(message.state)}`);
        }
      } catch (err) {
        settle(err);
      }
    });
    void job.result.then((result) => settle(new Error(`supervisor exited before readiness: ${JSON.stringify(result.command)}; stderr=${stderr || 'none'}`)));
  });
}

// The supervisor is the worker's owner. Killing it outright must take the worker and its job's
// leader with it: the leader sees its owner's channel close and releases its own group.
async function proveParentLoss(mode: 'observer' | 'watcher', configPath: string): Promise<void> {
  const supervisor = spawnOwned([process.execPath, SUPERVISOR, mode, packageRoot, configPath]);
  let pids: { worker: number; leader: number } | null = null;
  // Identities read when the supervisor publishes each pid, while the processes are known to be ours;
  // emergency cleanup signals only a pid whose identity still matches.
  const identities = new Map<number, ProcessIdentity | 'gone' | 'unknown'>();
  const remember = (published: { worker: number; leader: number }) => {
    for (const pid of [published.worker, published.leader]) if (!identities.has(pid)) identities.set(pid, readIdentity(pid));
  };
  let primaryError: unknown = null;
  try {
    pids = await withinTest(
      `${mode} supervisor readiness`,
      DEADLINE_MS,
      waitForReady(supervisor, (spawned) => {
        pids = spawned;
        remember(spawned);
      }),
      () => supervisor.fail(`${mode} supervisor readiness exceeded the test watchdog`)
    );
    remember(pids);
    if (supervisor.commandPid === null || supervisor.exited !== null) throw new Error(`${mode} supervisor is not running`);
    process.kill(supervisor.commandPid, 'SIGKILL');
    const ended = await withinTest(`${mode} supervisor reap`, DEADLINE_MS, supervisor.result, () => supervisor.fail(`${mode} supervisor reap exceeded the test watchdog`));
    // Windows PID-directed SIGKILL uses TerminateProcess(1), without a signal on the observing handle.
    const expected = process.platform === 'win32' ? { code: 1, signal: null } : { code: null, signal: 'SIGKILL' };
    assert.deepEqual(ended.command, expected, `${mode} supervisor did not die by SIGKILL: ${JSON.stringify(ended)}`);
    assert.equal(await waitForExit(pids.worker, DEADLINE_MS), true, `${mode} worker ${pids.worker} survived its supervisor`);
    assert.equal(await waitForExit(pids.leader, DEADLINE_MS), true, `${mode} worker leader ${pids.leader} survived its supervisor`);
  } catch (err) {
    primaryError = err;
  }

  const cleanupErrors: unknown[] = [];
  try {
    supervisor.fail('test cleanup');
    await withinTest(`${mode} supervisor cleanup`, DEADLINE_MS, supervisor.result, () => undefined);
  } catch (err) {
    cleanupErrors.push(err);
  }
  // Emergency containment of this test's own workers, by verified identity only; any survivor is a
  // cleanup failure reported apart from the proof's own outcome.
  for (const [pid, identity] of identities) {
    if (identity === 'gone') continue;
    if (identity === 'unknown') {
      if (processExists(pid)) cleanupErrors.push(new Error(`${mode} process ${pid} is still running and its identity was unknown at publication; not signalled`));
      continue;
    }
    const contained = await killVerified(identity, DEADLINE_MS);
    if (contained.outcome !== 'gone-before') cleanupErrors.push(new Error(`${mode} process ${pid} outlived the proof: ${contained.outcome}${contained.detail ? ` (${contained.detail})` : ''}`));
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
