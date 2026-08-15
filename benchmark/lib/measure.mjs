// Shared measurement helpers for run.mjs / sweep.mjs / profile.mjs. One definition of
// "an indexed file", "a timed CLI run", and "a median" -- a change here lands in every
// harness at once instead of skewing them apart.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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

export function median(fn, runs) {
  const times = Array.from({ length: runs }, fn).sort((a, b) => a - b);
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
