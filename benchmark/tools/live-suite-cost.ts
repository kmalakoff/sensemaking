import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../src/lib/atomic-write.ts';
import { LIVE_SUITE_ARGV, LIVE_SUITE_COST_ARTIFACT, LIVE_SUITE_ENV, liveSuiteMachine, liveSuiteProvenance, liveSuiteRuntime } from '../lib/gates.ts';
import { ROOT } from '../lib/stages.ts';
import { jobProblems, spawnOwned } from '../lib/step-process.ts';

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
// An owned job, so the suite's whole tree (tsds, mocha, test children, npm) is released with it.
const job = spawnOwned(LIVE_SUITE_ARGV, { cwd: ROOT, env: { ...process.env, ...LIVE_SUITE_ENV } });
const append = (chunk: Buffer): void => {
  const text = chunk.toString();
  writeFileSync(logPath, text, { flag: 'a' });
  process.stdout.write(text);
};
job.stdout.on('data', append);
job.stderr.on('data', append);
const outcome = await job.result;
const result = typeof outcome.command === 'object' ? outcome.command : { code: null, signal: null };
const jobError = jobProblems(outcome).join('; ') || null;

const elapsedMs = Date.now() - started;
const logBytes = readFileSync(logPath);
const logInfo = { path: logName, bytes: logBytes.length, sha256: createHash('sha256').update(logBytes).digest('hex') };
const provenanceAfter = liveSuiteProvenance(ROOT);
const passingCount = Number(/(?:^|\n)\s*(\d+) passing\b/.exec(logBytes.toString('utf8'))?.[1] ?? 0);
const success = !jobError && result.code === 0 && result.signal === null && passingCount > 0 && JSON.stringify(provenanceBefore) === JSON.stringify(provenanceAfter);
writeArtifact(artifact(success ? 'ok' : 'failed', { recorded_at: new Date().toISOString(), elapsed_ms: elapsedMs, exit_code: result.code, signal: result.signal, passing_count: passingCount, provenance_after: provenanceAfter, log: logInfo, ...(jobError ? { error: jobError } : {}) }));
if (!success) process.exitCode = 1;
