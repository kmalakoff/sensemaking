// Shared measurement helpers for run.mjs / sweep.mjs / profile.mjs: one definition of "an
// indexed file", "a timed CLI run", and "a median", so a change here lands in every harness at once instead of skewing them apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// What this harness measures and how. Bump when an existing row starts being measured differently.
//   m1  the shape before 2026-09-02
//   m2  the corpus is copied before measuring, the file cache is warmed before timing, and cold
//       crawl, in-process cold build and both bulk rows became medians of 3
//   m3  a third preset joins the measured tree, so a cold build indexes one more preset-membership
//       row per note and `map` prints one more line: every token row shifts against an m2 prior
export const MEASURE_VERSION = 'm3';

// Sorted relPaths of the .md files a crawl would see (dotfiles and node_modules skipped).
export function walkMd(tree) {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(join(tree, dir), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md')) out.push(rel);
    }
  })('');
  return out.sort();
}

// Reads every indexed file once so the page cache is warm before anything is timed. Without it the
// first timed run pays disk reads the later ones do not: -38% at 13k, -40% at 26k, one tree, a day apart.
export function warmFileCache(tree) {
  let bytes = 0;
  for (const rel of walkMd(tree)) bytes += readFileSync(join(tree, rel)).length;
  return bytes;
}

export function median(fn, runs) {
  const times = Array.from({ length: runs }, fn).sort((a, b) => a - b);
  return Math.round(times[Math.floor(runs / 2)] * 10) / 10;
}

// Awaits each run in turn: an async fn through median()'s Array.from would sort promises.
export async function medianAsync(fn, runs) {
  const times = [];
  for (let i = 0; i < runs; i++) times.push(await fn());
  times.sort((a, b) => a - b);
  return Math.round(times[Math.floor(runs / 2)] * 10) / 10;
}

// Median wall time of `runs` spawns of the CLI; bytes/stderr are from the last run.
export function timedCli(spawnOnce, runs) {
  const times = [];
  let out = null;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    out = spawnOnce();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(runs / 2)]), status: out.status, bytes: (out.stdout ?? '').length, stderr: out.stderr };
}

// mtimes in the near future so a touch always reads as newer than the indexed value.
export const futureDate = () => new Date(Date.now() + 60_000 + Math.random() * 60_000);

// Median of a collected sample array, same rounding as median(): for callers that must vary a side
// effect between reps (clearing .sense, re-touching) and so build the array themselves.
export function medianOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}
