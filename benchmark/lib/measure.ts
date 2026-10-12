// Shared measurement helpers for run.mjs / sweep.ts / profile.ts: one definition of "an
// indexed file", "a timed CLI run", and "a median", so a change here lands in every harness at once instead of skewing them apart.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkMd } from './work-tree.ts';

export { walkMd } from './work-tree.ts';

// What this harness measures and how. Bump when an existing row starts being measured differently.
//   m1  the shape before 2026-09-02
//   m2  the corpus is copied before measuring, the file cache is warmed before timing, and cold
//       crawl, in-process cold build and both bulk rows became medians of 3
//   m3  a third preset joins the measured tree, so a cold build indexes one more preset-membership
//       row per note and `map` prints one more line: every token row shifts against an m2 prior
//   m4  in-process and bulk repetitions use verified fresh copies, deterministic mutations, and
//       exact native state checks outside timing; bulk watcher events are wake-ups, not readiness
//   m5  lexical timing starts only after a public result and native index readiness preflight
export const MEASURE_VERSION = 'm5';

// Every verb `sense --help` advertises, read off its own output rather than hard-coded, so a
// verb the CLI under test genuinely lacks reads as unmeasured rather than as a command that
// broke. `sense <name>` (the saved-query placeholder) and `sense --list`/`--version` are not verbs.
export function verbsFrom(helpText: string) {
  const verbs = new Set<string>();
  for (const m of helpText.matchAll(/^\s*(?:usage:\s*)?\S+\s+(\S+)/gm)) {
    if (/^[a-z][\w-]*$/i.test(m[1])) verbs.add(m[1]);
  }
  return verbs;
}

// Reads every indexed file once so the page cache is warm before anything is timed. Without it the
// first timed run pays disk reads the later ones do not: -38% at 13k, -40% at 26k, one tree, a day apart.
export function warmFileCache(tree: string) {
  let bytes = 0;
  for (const rel of walkMd(tree)) bytes += readFileSync(join(tree, rel)).length;
  return bytes;
}

export function median(fn: (value: unknown, index: number) => number, runs: number) {
  const times = Array.from({ length: runs }, fn).sort((a, b) => a - b);
  return Math.round(times[Math.floor(runs / 2)] * 10) / 10;
}

// Awaits each run in turn: an async fn through median()'s Array.from would sort promises.
export async function medianAsync(fn: () => number | Promise<number>, runs: number) {
  const times = [];
  for (let i = 0; i < runs; i++) times.push(await fn());
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(runs / 2)] * 10) / 10;
}

const MAX_RECORDED_STDOUT_BYTES = 64 * 1024;

export function stdoutEvidence(stdout: string) {
  const utf8Bytes = Buffer.byteLength(stdout);
  return {
    stdout_utf16_code_units: stdout.length,
    stdout_sha256: createHash('sha256').update(stdout).digest('hex'),
    stdout_utf8_bytes: utf8Bytes,
    stdout_text_status: utf8Bytes <= MAX_RECORDED_STDOUT_BYTES ? 'recorded' : 'omitted-over-limit',
    ...(utf8Bytes <= MAX_RECORDED_STDOUT_BYTES ? { stdout } : {}),
  };
}

export function structuredSearchEvidence(stdout: string) {
  const rows: { path: string; via?: unknown; snippets?: unknown; hit?: unknown; [key: string]: unknown }[] = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw new Error('json output is not an array');
  if (rows.length === 0) throw new Error('unexpected empty search output');
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || row.path.length === 0) throw new Error(`json row ${index} has no nonempty string path`);
  }
  const paths = rows.map((row) => row.path);
  if (new Set(paths).size !== paths.length) throw new Error('json output has duplicate paths');
  const snippets = (row: (typeof rows)[number]): string[] | null => {
    for (const key of ['snippets', 'hit']) {
      if (typeof row[key] === 'string') return [row[key]];
      if (Array.isArray(row[key]) && row[key].every((snippet) => typeof snippet === 'string')) return row[key];
    }
    return null;
  };
  return {
    paths,
    via: rows.map((row) => row.via ?? null),
    snippet_sha256: rows.map((row) => snippets(row)?.map((snippet) => createHash('sha256').update(snippet).digest('hex')) ?? null),
  };
}

// Median wall time of `runs` spawns of the CLI. A failed repetition invalidates the row even if a
// later repetition succeeds, and every repetition keeps its status and stderr for the artifact.
export function timedCli(spawnOnce: () => { status?: number | null; signal?: NodeJS.Signals | null; stdout?: string | null; stderr?: string | null; error?: Error | string | null } | null | undefined, runs: number) {
  const times = [];
  const repetitions = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    let out: NonNullable<ReturnType<typeof spawnOnce>>;
    try {
      out = spawnOnce() ?? { status: null, signal: null, stdout: '', stderr: '', error: 'Error: runner returned no result' };
    } catch (err) {
      out = { status: null, signal: null, stdout: '', stderr: '', error: `${(err as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(err as Partial<Error> | null | undefined)?.message ?? err}` };
    }
    const elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;
    times.push(elapsedMs);
    const stdout = out.stdout ?? '';
    const error = out.error ? (typeof out.error === 'string' ? out.error : `${out.error.name ?? 'Error'}: ${out.error.message ?? out.error}`) : null;
    repetitions.push({
      run: i + 1,
      elapsed_ms: elapsedMs,
      status: out.status ?? null,
      signal: out.signal ?? null,
      bytes: stdout.length,
      ...stdoutEvidence(stdout),
      stderr: out.stderr ?? '',
      error,
    });
  }
  times.sort((a, b) => a - b);
  const failures = repetitions.filter((r) => r.status !== 0 || r.signal || r.error);
  const last = repetitions[repetitions.length - 1];
  const firstFailure = failures[0];
  const failureText = failures.map((r) => `run ${r.run}: ${r.error ?? `status ${r.status ?? 'null'}${r.signal ? ` (${r.signal})` : ''}${r.stderr ? `: ${r.stderr.trim()}` : ''}`}`).join('\n');
  return {
    ms: firstFailure ? null : Math.round(times[Math.floor(runs / 2)]),
    // Any failed repetition makes status nonzero or null so callers cannot accept the median.
    status: firstFailure ? (firstFailure.status === 0 ? null : firstFailure.status) : last.status,
    signal: firstFailure?.signal ?? last.signal,
    bytes: last.bytes,
    stderr: firstFailure ? failureText : last.stderr,
    error: firstFailure ? { name: 'TimedCliError', message: failureText, repetitions: failures } : null,
    repetitions,
  };
}

// mtimes in the near future so a touch always reads as newer than the indexed value.
export const futureDate = () => new Date(Date.now() + 60_000 + Math.random() * 60_000);

// Median of a collected sample array, same rounding as median(): for callers that must vary a side
// effect between reps (clearing .sense, re-touching) and so build the array themselves.
export function medianOf(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}
