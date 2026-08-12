// Benchmark one sensemaking package against one vault; prints a JSON row for BENCHMARKING.md.
// usage: node bench/run.mjs <package-root> <vault-dir>
// Wall-time metrics spawn the CLI (what a calling agent pays, ~40ms Node startup included);
// in-process metrics import the library and time the engine alone (index build, freshness
// check, incremental update).
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkgRoot, vault] = process.argv.slice(2);
if (!pkgRoot || !vault) {
  console.error('usage: node bench/run.mjs <package-root> <vault-dir>');
  process.exit(2);
}
const cli = join(pkgRoot, 'bin', 'cli.js');

const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: vault, encoding: 'utf8', maxBuffer: 64e6 });

function timed(args, runs = 5) {
  const times = [];
  let out = null;
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    out = run(args);
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { ms: Math.round(times[Math.floor(runs / 2)]), status: out.status, bytes: (out.stdout ?? '').length };
}

const fail = (r) => (r.status === 0 ? r : null);

// Largest note: peek target and the read-cost baseline. Also collect files for update benchmarks.
const mdFiles = [];
(function walk(dir) {
  for (const e of readdirSync(join(vault, dir), { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(rel);
    else if (e.name.endsWith('.md')) mdFiles.push({ rel, size: statSync(join(vault, rel)).size });
  }
})('');
const largest = mdFiles.reduce((a, b) => (b.size > a.size ? b : a), { rel: null, size: 0 });

const SEARCH = `SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10`;

// --- wall-time (CLI) ---
rmSync(join(vault, '.sense'), { recursive: true, force: true });
const cold = timed(['status'], 1); // first open = full crawl
const warm = fail(timed(['query', 'SELECT COUNT(*) AS n FROM frontmatter']));
const search = fail(timed(['query', SEARCH, 'the']));
const findR = fail(timed(['find', 'the', '--k', '10'], 3));
const mapR = fail(timed(['map'], 3));
const peekR = fail(timed(['peek', largest.rel], 3));

// --- in-process (library) ---
let inproc = null;
try {
  const lib = await import(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href);
  const cfg = { scan: { include: ['**/*.md'] }, queries: {}, baseDir: vault, configPath: null };
  const openClose = () => {
    const t = process.hrtime.bigint();
    const { db } = lib.open(cfg);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    db.close();
    return ms;
  };
  const median = (fn, runs) => {
    const times = Array.from({ length: runs }, fn).sort((a, b) => a - b);
    return Math.round(times[Math.floor(runs / 2)] * 10) / 10;
  };
  const touch = (files) => {
    const future = new Date(Date.now() + 60_000 + Math.random() * 60_000);
    for (const f of files) utimesSync(join(vault, f.rel), future, future);
  };

  const noChange = median(openClose, 5);
  const touch1 = median(() => {
    touch(mdFiles.slice(0, 1));
    return openClose();
  }, 3);
  const modify10 = median(() => {
    for (const f of mdFiles.slice(0, 10)) appendFileSync(join(vault, f.rel), ' benchmark-edit');
    touch(mdFiles.slice(0, 10));
    return openClose();
  }, 3);
  rmSync(join(vault, '.sense'), { recursive: true, force: true });
  const t = process.hrtime.bigint();
  const { db } = lib.open(cfg);
  const coldBuild = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
  db.close();
  inproc = { cold_build_ms: coldBuild, open_nochange_ms: noChange, update_1_file_ms: touch1, update_10_files_ms: modify10 };
} catch (err) {
  inproc = { error: String(err.message ?? err).split('\n')[0] };
}

console.log(
  JSON.stringify(
    {
      vault,
      notes: mdFiles.length,
      cold_crawl_ms: cold.status === 0 ? cold.ms : `FAILED(exit ${cold.status})`,
      warm_query_ms: warm?.ms ?? null,
      bm25_search_ms: search?.ms ?? null,
      find_ms: findR?.ms ?? null,
      map_ms: mapR?.ms ?? null,
      map_tokens: mapR ? Math.round(mapR.bytes / 4) : null,
      peek_ms: peekR?.ms ?? null,
      peek_tokens: peekR ? Math.round(peekR.bytes / 4) : null,
      largest_note_tokens: Math.round(largest.size / 4),
      inproc,
    },
    null,
    2
  )
);
