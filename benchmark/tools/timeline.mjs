#!/usr/bin/env node
// Measures published versions against one corpus with the current harness, so performance across
// releases reads like for like. Decision support, never part of a release gate.
//
// Sequential by construction: one run at a time, because two measuring at once measure each other.
// Repeats are cycled rather than grouped, so slow machine drift lands on every version equally
// instead of penalising whichever ran during a spike.
//
// A published version's numbers never change, so a result already on disk is never re-measured.
// Delete a file to re-measure it; delete the directory to start over.
//
// usage: node benchmark/tools/timeline.mjs [--corpus <name>] [--repeats 3] [--out <dir>]
//                                          [--timeout <ms>] [--no-timeouts] [--dry-run]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { quietMachineCheck } from '../lib/quiet-machine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  values: { corpus, repeats: repeatsArg, out: outArg, timeout: timeoutArg, 'dry-run': dryRun, 'no-timeouts': noTimeouts },
} = parseArgs({
  options: {
    corpus: { type: 'string', default: 'obsidian-hub' },
    repeats: { type: 'string', default: '3' },
    out: { type: 'string' },
    timeout: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'no-timeouts': { type: 'boolean', default: false },
  },
});
const repeats = Number(repeatsArg);
// The corpus is part of the key. The same version on two trees is two results, so they cannot
// share a filename; a new corpus is a new directory that fills in without disturbing the others.
const outDir = outArg ?? join(ROOT, '.tmp', 'timeline', corpus);
// An early version can be orders of magnitude slower than a current one, which is the finding
// rather than a fault, so the budget is the caller's to set. --no-timeouts lets a slow version
// take as long as it takes.
const timeout = noTimeouts ? undefined : Number(timeoutArg ?? 2 * 60 * 60_000);

// Work that would contend with a measurement. A sitting taken alongside any of these is not one
// sitting, and the numbers cannot be compared with the rest of the series.
const INTERFERES = /measure-tree|tools\/timeline|run-matrix|mocha|tsds|benchmark\/(gate|steps|store-dump)/;

function interfering() {
  const self = new Set([String(process.pid), String(process.ppid)]);
  try {
    return execFileSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [pid, ppid, ...rest] = l.split(/\s+/);
        return { pid, ppid, command: rest.join(' ') };
      })
      .filter((p) => !self.has(p.pid) && !self.has(p.ppid) && INTERFERES.test(p.command));
  } catch {
    return [];
  }
}

// spawnSync's timeout signals its direct child only, so a killed measure-tree leaves the sense CLI
// it spawned running, reparented to init. One was found at 91% CPU with 13 minutes of accumulated
// time, contending with every run after it. Reap by hand rather than trusting the kill.
function reapStragglers() {
  let reaped = 0;
  for (const p of interfering()) {
    if (p.ppid !== '1' || !p.command.includes('.tmp/cache/sensemaking-')) continue;
    try {
      process.kill(Number(p.pid), 'SIGKILL');
      reaped++;
      console.error(`  reaped orphan ${p.pid}: ${p.command.slice(0, 70)}`);
    } catch {}
  }
  return reaped;
}

const cacheDir = join(ROOT, '.tmp', 'cache');
const pkgRoot = (v) => join(cacheDir, `sensemaking-${v}`, 'node_modules', 'sensemaking');

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

// Each package states which stores it offers, in its own schema.json. Reading it there beats a
// table here that would drift: naming a store an old package lacks is silently ignored, so the run
// would be recorded as that store while actually measuring sqlite.
function storesOf(version) {
  try {
    const schema = JSON.parse(readFileSync(join(pkgRoot(version), 'schema.json'), 'utf8'));
    return schema.properties?.store?.enum ?? ['sqlite'];
  } catch {
    return ['sqlite'];
  }
}

const versions = readdirSync(cacheDir)
  .filter((d) => d.startsWith('sensemaking-'))
  .map((d) => d.slice('sensemaking-'.length))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .sort(cmp);
const populated = versions.filter((v) => existsSync(join(pkgRoot(v), 'dist', 'esm', 'index.js')));
const hollow = versions.filter((v) => !populated.includes(v));

const matrix = populated.flatMap((version) => storesOf(version).map((store) => ({ version, store })));
const wanted = [];
for (let repeat = 1; repeat <= repeats; repeat++) for (const pair of matrix) wanted.push({ ...pair, repeat });
const todo = wanted.filter(({ version, store, repeat }) => !existsSync(join(outDir, `${version}-${store}-${repeat}.json`)));

console.log(`corpus ${corpus}, ${populated.length} versions installed, ${repeats} repeats`);
console.log(`results: ${outDir}`);
if (hollow.length) console.log(`not installed, so not measured: ${hollow.join(', ')}`);
console.log(`${wanted.length} runs in the matrix, ${wanted.length - todo.length} already on disk, ${todo.length} to run`);
console.log(`timeout: ${timeout === undefined ? 'none' : `${Math.round(timeout / 60000)} min`}`);
for (const v of populated) console.log(`  ${v}: ${storesOf(v).join(', ')}`);
if (dryRun) process.exit(0);

// Pre-flight. Load first, then the process list, because a quiet load average says nothing about a
// second collector that has not started measuring yet.
const busy = interfering();
const { blocked, message } = quietMachineCheck(loadavg()[0], cpus().length);
if (message) console.error(message);
if (busy.length) {
  console.error(`${busy.length} process(es) would contend with this sitting:`);
  for (const p of busy) console.error(`  ${p.pid} (parent ${p.ppid}): ${p.command.slice(0, 90)}`);
}
if (blocked || busy.length) {
  console.error('\nRefusing to start. Stop the above and run again; results already on disk are never re-measured, so nothing is lost.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const started = new Date().toISOString();
const loadStart = loadavg()[0];
const contended = [];
let done = 0;
let failed = 0;

for (const { version, store, repeat } of todo) {
  const out = join(outDir, `${version}-${store}-${repeat}.json`);
  const at = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, 'benchmark', 'steps', 'measure-tree.mjs'), pkgRoot(version), corpus, '--store', store, '--out', out], { cwd: ROOT, encoding: 'utf8', timeout, killSignal: 'SIGKILL' });
  const mins = ((Date.now() - at) / 60000).toFixed(1);
  // Anything that appeared mid-sitting is recorded against the run it overlapped, so a suspect
  // number can be found later rather than argued about.
  const during = interfering();
  if (during.length) contended.push({ run: `${version}-${store}-${repeat}`, saw: during.map((p) => p.command.slice(0, 80)) });
  if (r.status === 0) {
    done++;
    console.log(`${version}/${store} #${repeat}: ok in ${mins}m`);
  } else {
    failed++;
    const why = r.signal === 'SIGKILL' ? `killed at the ${Math.round((timeout ?? 0) / 60000)} min budget` : `exit ${r.status}`;
    writeFileSync(join(outDir, `${version}-${store}-${repeat}.log`), `${new Date(at).toISOString()}\n${why} after ${mins}m\n${r.stderr ?? ''}`);
    console.error(`${version}/${store} #${repeat}: FAILED, ${why} after ${mins}m`);
    reapStragglers();
  }
}

writeFileSync(join(outDir, '_sitting.json'), JSON.stringify({ corpus, repeats, timeout_ms: timeout ?? null, started, finished: new Date().toISOString(), cores: cpus().length, load_start: loadStart, load_end: loadavg()[0], matrix: matrix.length, ran: todo.length, done, failed, hollow, contended }, null, 2));
console.log(`\n${done} ok, ${failed} failed. ${join(outDir, '_sitting.json')}`);
