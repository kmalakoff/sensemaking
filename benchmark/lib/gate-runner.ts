import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type JobResult, jobProblems, type OwnedJob, spawnOwned } from './step-process.ts';

interface RunOptions<S, R, T> {
  isOwed: (step: S) => unknown;
  resume: (step: S) => T;
  run: (step: S) => R | Promise<R>;
  recordNotOwed: (step: S) => unknown;
  recordResume: (step: S, recorded: NonNullable<T>) => unknown;
  recordResult: (step: S, result: R) => unknown;
  collectIndependent?: boolean;
  blockedBy?: ((step: S) => string[] | null | undefined) | null;
  recordBlocked?: ((step: S, prerequisites: string[]) => unknown) | null;
}

// Artifact parsing is evidence collection, not a reason to abandon unrelated steps. A missing
// or malformed promised output must remain a failed step rather than a resumable success.
// A re-run never overwrites an earlier attempt's evidence: the step's output and log move to
// attempts/<id>/<n>/ first, with the record they belonged to, so the step must write fresh output at
// the target to count. Byte-identical fresh output is still fresh; nothing compares contents.
export function preserveAttempt(sittingDir: string, id: string, record: unknown) {
  const prior = [`${id}.json`, `${id}.log`].filter((name) => existsSync(join(sittingDir, name)));
  if (prior.length === 0) return null;
  const attempts = join(sittingDir, 'attempts', id);
  mkdirSync(attempts, { recursive: true });
  let n = 1;
  while (existsSync(join(attempts, String(n)))) n++;
  const dir = join(attempts, String(n));
  mkdirSync(dir);
  for (const name of prior) renameSync(join(sittingDir, name), join(dir, name));
  writeFileSync(join(dir, 'attempt.json'), `${JSON.stringify({ moved_at: new Date().toISOString(), files: prior, record }, null, 2)}\n`);
  return dir;
}

// One gate step: an owned job whose stdout and stderr are echoed and written to a fresh log. The
// log is evidence, so failing to open, write or close it fails the step; it never leaves the job
// running, and a flush error after the job settled still fails the result. Cancellation keeps
// precedence over every other status.
export async function runLoggedJob(argv: readonly string[], { cwd, env, logPath, onStart, echo = true }: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; onStart?: (job: OwnedJob) => void; echo?: boolean }) {
  const job = spawnOwned(argv, { cwd, env });
  onStart?.(job);
  let logError: string | null = null;
  const logStream = createWriteStream(logPath, { flags: 'wx' });
  const logClosed = new Promise<void>((resolveLog) => logStream.once('close', () => resolveLog()));
  logStream.on('error', (err) => {
    logError ??= `step log ${logPath}: ${err.message}`;
    job.fail(logError);
  });
  const toLog = (chunk: Buffer) => {
    if (!logError) logStream.write(chunk);
  };
  job.stdout.on('data', (chunk: Buffer) => {
    if (echo) process.stdout.write(chunk);
    toLog(chunk);
  });
  job.stderr.on('data', (chunk: Buffer) => {
    if (echo) process.stderr.write(chunk);
    toLog(chunk);
  });
  const result: JobResult = await job.result;
  logStream.end();
  await logClosed;
  // Set by the stream's error handler, so read through its declared type.
  const flushError = logError as string | null;
  const details = jobProblems(result);
  let status: JobResult['status'] = result.status;
  if (flushError) {
    if (!details.includes(flushError)) details.push(flushError);
    if (status !== 'cancelled') status = 'failed';
  }
  return { result, status, details, logError: flushError };
}

export function stepOutputEvidence(outPath: string) {
  try {
    const out: { versions?: unknown } | null = JSON.parse(readFileSync(outPath, 'utf8'));
    return Array.isArray(out?.versions) ? { column_order: out.versions as unknown[] } : {};
  } catch (error) {
    return { status: 'failed', detail: `invalid step output ${outPath}: ${(error as { message: unknown }).message}` };
  }
}

export async function runStageSteps<S, R, T>(steps: readonly S[], { isOwed, resume, run, recordNotOwed, recordResume, recordResult, collectIndependent = false, blockedBy = (_step: S) => /** @type {string[]} */ ([]), recordBlocked = (_step: S, _prerequisites: string[]) => {} }: RunOptions<S, R, T>) {
  const failures: { step: S; status: unknown; prerequisites?: string[] }[] = [];
  for (const step of steps) {
    if (!isOwed(step)) {
      await recordNotOwed(step);
      continue;
    }
    const recorded = resume(step);
    if (recorded) {
      await recordResume(step, recorded);
      continue;
    }
    const prerequisites = blockedBy?.(step) ?? [];
    if (prerequisites.length > 0) {
      await recordBlocked?.(step, prerequisites);
      failures.push({ step, status: 'not-run', prerequisites });
      continue;
    }
    const result = await run(step);
    const status = await recordResult(step, result);
    if (status !== 'ok' && status !== 'owed-unmet') {
      if (!collectIndependent) return { failed: true, step, status };
      failures.push({ step, status });
    }
  }
  return failures.length > 0 ? { failed: true, failures } : { failed: false };
}
