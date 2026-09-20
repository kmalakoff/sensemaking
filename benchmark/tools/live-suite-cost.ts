import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/lib/atomic-write.ts';
import { LIVE_SUITE_ARGV, LIVE_SUITE_COST_ARTIFACT, LIVE_SUITE_ENV, liveSuiteMachine, liveSuiteProvenance, liveSuiteRuntime } from '../lib/gates.mjs';
import { signalProcessTree } from '../lib/native-observer.mjs';
import { ROOT } from '../lib/stages.mjs';

const dir = join(ROOT, '.tmp', 'live-suite-cost');
const logName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.log`;
const logPath = join(dir, logName);
const artifactPath = join(ROOT, LIVE_SUITE_COST_ARTIFACT);
const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const runtime = liveSuiteRuntime();
const machine = liveSuiteMachine();
const provenanceBefore = liveSuiteProvenance(ROOT);

mkdirSync(dir, { recursive: true });

function artifact(status: string, extra: Record<string, unknown> = {}) {
  return {
    schema: 'live-suite-cost-v1',
    status,
    argv: LIVE_SUITE_ARGV,
    env: LIVE_SUITE_ENV,
    package_version: packageVersion,
    runtime,
    machine,
    provenance: provenanceBefore,
    log: { path: logName },
    ...extra,
  };
}

function writeArtifact(value: Record<string, unknown>): void {
  writeFileAtomic(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

writeArtifact(artifact('running'));
writeFileSync(logPath, '', { flag: 'wx' });
const started = Date.now();
const child = spawn(LIVE_SUITE_ARGV[0], LIVE_SUITE_ARGV.slice(1), {
  cwd: ROOT,
  env: { ...process.env, ...LIVE_SUITE_ENV },
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
const append = (chunk: Buffer): void => {
  const text = chunk.toString();
  writeFileSync(logPath, text, { flag: 'a' });
  process.stdout.write(text);
};
child.stdout?.on('data', append);
child.stderr?.on('data', append);

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try {
    signalProcessTree(child, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}, 120_000);

let spawnError: Error | null = null;
const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
  child.once('error', (error) => {
    spawnError = error;
    resolve({ code: null, signal: null });
  });
  child.once('close', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timer);

const elapsedMs = Date.now() - started;
const logBytes = readFileSync(logPath);
const logInfo = { path: logName, bytes: logBytes.length, sha256: createHash('sha256').update(logBytes).digest('hex') };
const provenanceAfter = liveSuiteProvenance(ROOT);
const passingCount = Number(/(?:^|\n)\s*(\d+) passing\b/.exec(logBytes.toString('utf8'))?.[1] ?? 0);
const success = !spawnError && !timedOut && result.code === 0 && result.signal === null && passingCount > 0 && JSON.stringify(provenanceBefore) === JSON.stringify(provenanceAfter);
writeArtifact(artifact(success ? 'ok' : 'failed', { recorded_at: new Date().toISOString(), elapsed_ms: elapsedMs, timed_out: timedOut, exit_code: result.code, signal: result.signal, passing_count: passingCount, provenance_after: provenanceAfter, log: logInfo, ...(spawnError ? { error: String(spawnError) } : {}) }));
if (!success) process.exitCode = 1;
