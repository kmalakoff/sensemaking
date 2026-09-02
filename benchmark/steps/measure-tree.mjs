// Benchmark one package against one tree; prints a JSON row for BENCHMARKING.md. Wall-time metrics spawn the CLI (what an agent pays); in-process ones time the engine alone.
// usage: node benchmark/steps/measure-tree.mjs <package-root> <notes-dir|corpus-name> [--store <name>] [--work <dir>] [--out <file>]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeRmSync } from 'fs-remove-compat';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from '../lib/corpus.mjs';
import { futureDate, medianAsync, medianOf, timedCli, walkMd, warmFileCache } from '../lib/measure.mjs';
import { writeOut } from '../lib/out.mjs';
import { copyTree, ephemeralWorkTree } from '../lib/work-tree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Extracts one `--flag value` pair, returning [value, argsWithoutIt]. Never mis-trims the
// positionals when the flag is absent (idx -1), since it only touches indices when idx >= 0.
function takeFlag(args, flag) {
  const idx = args.indexOf(flag);
  return idx < 0 ? [null, args] : [args[idx + 1], args.filter((_a, i) => i !== idx && i !== idx + 1)];
}

// The store is a config fact the harness writes into the tree. Pre-store packages have no `search` verb and read the config as-is, ignoring the flag.
// Every old column of a compare run stays a valid sqlite measurement.
const [store, afterStore] = takeFlag(process.argv.slice(2), '--store');
// Where the measured copy goes. Defaults under this package's own .tmp/, not the tree's.
const [workArg, afterWork] = takeFlag(afterStore, '--work');
const [outArg, rest] = takeFlag(afterWork, '--out');
const [pkgRootArg, treeArg] = rest;
if (!pkgRootArg || !treeArg) {
  console.error('usage: node bench/run.mjs <package-root> <notes-dir|corpus-name> [--store <name>] [--work <dir>] [--out <file>]');
  process.exit(2);
}
// Absolute from the start: spawns below run with cwd set to the tree.
const pkgRoot = resolve(pkgRootArg);
// A known corpus name builds and caches itself (atomic, fetch-once) rather than needing a
// pre-materialized path; anything else is treated as a directory path. Read-only from here on.
const sourceTree = CORPUS_NAMES.includes(treeArg) ? corpusPath(treeArg) : resolve(treeArg);
const cli = join(pkgRoot, 'bin', 'cli.js');

// A run measures a private copy, never the cached corpus: benchmark/lib/work-tree.mjs is the
// same mechanism compare.mjs and store-dump.mjs use. Without this, run.mjs's in-place edits
// below would drift the cache itself.
const copyStart = process.hrtime.bigint();
let tree;
if (workArg) {
  tree = resolve(workArg);
  mkdirSync(tree, { recursive: true });
  copyTree(sourceTree, tree);
} else {
  tree = ephemeralWorkTree(join(ROOT, '.tmp'), 'run-', sourceTree);
}
const copyMs = Math.round(Number(process.hrtime.bigint() - copyStart) / 1e6);

const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: tree, encoding: 'utf8', maxBuffer: 64e6 });

const timed = (args, runs = 5) => timedCli(() => run(args), runs);

const fail = (r) => (r.status === 0 ? r : null);

// Dialect detection: pre-rename packages have no `search` verb, so their --help never mentions it. Runs once.
// Every row-mapping choice below reads off this one flag, so old and new packages land in the same JSON shape for compare.mjs.
const HELP = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout ?? '';
const NEW_DIALECT = /search/.test(HELP);
// Ad-hoc SQL was `query` until it became `sql`, which took the name back from the search
// sense of "query". Read off --help so one harness measures every generation.
const SQL_VERB = /\bsense sql\b/.test(HELP) ? 'sql' : 'query';
// Both rows must measure the same files, differing only in vector participation: two presets
// over one glob, so there is no config edit between rows to force a rebuild.
// The default preset carries no `semantic: false`, so migrating this file to the current config
// version turns embedding on with the default static model -- verified, not merely inferred.
const TWO_SCOPES = {
  version: 3,
  presets: { default: { include: ['**/*.md'] }, lexical: { include: ['**/*.md'], semantic: false } },
  queries: {},
};
// find_ms: lexical ranked search (BM25 + link fusion, no vectors) -- old dialect is
// already lexical-only, preset-era packages scope to the semantic:false preset above.
const lexicalArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--preset', 'lexical', '--k', k] : ['find', terms, '--k', k]);
// semantic_find_ms: vector-participating search -- old dialect opts in with --semantic,
// new dialect participates by default.
const vectorArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--k', k] : ['find', terms, '--semantic', '--k', k]);

// version_canary_ms: bare Node startup plus argv parsing, no tree work at all -- the number
// BENCHMARKING.md's Interpreting section calls the canary for "startup got heavier".
const versionCanary = timed(['--version'], 5);

// Largest note: peek target and the read-cost baseline. Also collect files for update benchmarks.
const mdFiles = walkMd(tree).map((rel) => ({ rel, size: statSync(join(tree, rel)).size }));
const largest = mdFiles.reduce((a, b) => (b.size > a.size ? b : a), { rel: null, size: 0 });

const SEARCH = `SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10`;

// --- wall-time (CLI) ---
if (NEW_DIALECT) writeTreeConfig(tree, TWO_SCOPES, { store });
// Every timed row measures a warm file cache, deliberately and identically in every sitting.
// "Cold" here means the index is built from nothing, not that the disk is cold: the latter
// depends on what the machine did minutes earlier and is not reproducible.
const warmedBytes = warmFileCache(tree);
// Median of 3, clearing .sense before each rep (PLAN.md 3.10: +21% same-code spread on one
// sample). The last rep leaves .sense built, which warm/search/find below reuse.
const COLD_REPS = 3;
const coldSamples = [];
let coldStatus = 0;
for (let i = 0; i < COLD_REPS; i++) {
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
  const r = timed(['status'], 1); // first open = full crawl
  coldSamples.push(r.ms);
  if (r.status !== 0) coldStatus = r.status;
}
const coldMs = medianOf(coldSamples);
const warm = fail(timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter']));
const search = fail(timed([SQL_VERB, SEARCH, 'the']));
const findR = fail(timed(lexicalArgs('the'), 3));
// Cold crawl and first embed together in one process: reconcile's chunk handoff (embed/handoff.ts)
// only survives within a single CLI invocation, so this is the only measurement that can see it --
// the `status` call above already reconciled (and exited) in its own process, discarding it.
rmSync(join(tree, '.sense'), { recursive: true, force: true });
const coldEmbedAttempt = timed(vectorArgs('the'), 1);
// Non-null only on embed-enabled trees (vectors pre-built by the run above). The delta
// vs find_ms is what vector participation pays per invocation: model load + query embed + scan.
const semanticR = fail(timed(vectorArgs('the'), 3));
const mapR = fail(timed(['map'], 3));
// A `find` row is an output contract like the map/peek token counts: a row is a reference, and its cost must not grow with the tree.
// Measured in json (the shape an agent parses), per row actually returned.
const findRowTokens = (() => {
  const out = run([...lexicalArgs('the'), '--format', 'json']);
  if (out.status !== 0) return null;
  try {
    const rows = JSON.parse(out.stdout);
    return rows.length ? Math.round(out.stdout.length / 4 / rows.length) : null;
  } catch {
    return null;
  }
})();
const peekR = fail(timed(['peek', largest.rel], 3));
// related_ms: the similar-but-unlinked command. Scans every embedding chunk in the tree per call (semantic-search cost class), unlike peek's cheap local queries.
// Runs after the semantic search above, which has warmed the embeddings this scan reads.
const relatedR = fail(timed(['related', largest.rel], 3));

// --- in-process (library) ---
let inproc = null;
try {
  const lib = await import(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href);
  // open() takes an already-resolved config, not a file to migrate -- so the shape here has
  // to match this package's own dialect (v1 `scan` pre-rename, v3 `presets` since).
  const cfg = NEW_DIALECT ? { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null, ...(store ? { store } : {}) } : { scan: { include: ['**/*.md'] }, queries: {}, baseDir: tree, configPath: null };
  // await tolerates a pre-rename package's synchronous open(); `store ?? db` picks whichever
  // dialect's result field this pkgRoot's build actually returns.
  const openClose = async () => {
    const t = process.hrtime.bigint();
    const opened = await lib.open(cfg);
    const handle = opened.store ?? opened.db;
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    await handle.close();
    return ms;
  };
  const touch = (files) => {
    const future = futureDate();
    for (const f of files) utimesSync(join(tree, f.rel), future, future);
  };

  const noChange = await medianAsync(openClose, 5);
  const touch1 = await medianAsync(() => {
    touch(mdFiles.slice(0, 1));
    return openClose();
  }, 3);
  const modify10 = await medianAsync(() => {
    for (const f of mdFiles.slice(0, 10)) appendFileSync(join(tree, f.rel), ' benchmark-edit');
    touch(mdFiles.slice(0, 10));
    return openClose();
  }, 3);
  // Median of 3, clearing .sense before each rep (same instrument-spread rationale as cold crawl).
  const COLD_BUILD_REPS = 3;
  const coldBuildSamples = [];
  for (let i = 0; i < COLD_BUILD_REPS; i++) {
    rmSync(join(tree, '.sense'), { recursive: true, force: true });
    const t = process.hrtime.bigint();
    const opened = await lib.open(cfg);
    coldBuildSamples.push(Math.round(Number(process.hrtime.bigint() - t) / 1e6));
    await (opened.store ?? opened.db).close();
  }
  const coldBuild = medianOf(coldBuildSamples);
  inproc = { cold_build_ms: coldBuild, cold_build_ms_samples: coldBuildSamples, open_nochange_ms: noChange, update_1_file_ms: touch1, update_10_files_ms: modify10 };
} catch (err) {
  inproc = { error: String(err.message ?? err).split('\n')[0] };
}

// --- bulk change (watch's scenario): touch many files, time the first query after ---
const BULK = Math.min(500, mdFiles.length);
// rep spaces each touch further into the future than the last, so a reconcile always sees a
// newer mtime than the one it just indexed.
const touchMany = (rep = 0) => {
  const future = new Date(Date.now() + 120_000 + rep * 60_000 + Math.random() * 60_000);
  for (const f of mdFiles.slice(0, BULK)) utimesSync(join(tree, f.rel), future, future);
};
run([SQL_VERB, 'SELECT 1']); // warm the cache first
// Median of 3, re-touching before each rep (PLAN.md 3.10: +73% same-code spread on one sample).
const BULK_REPS = 3;
const bulkSamples = [];
let bulkStatus = 0;
for (let i = 0; i < BULK_REPS; i++) {
  touchMany(i);
  const r = timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter'], 1);
  bulkSamples.push(r.ms);
  if (r.status !== 0) bulkStatus = r.status;
}
const bulkColdMs = bulkStatus === 0 ? medianOf(bulkSamples) : null;

// Same change with a watcher already running: it reparses in the background, so the
// first query pays only the freshness check. One watcher for all 3 reps: startup is a fixed
// cost the row is not measuring.
let bulkWatchMs = null;
const bulkWatchSamples = [];
try {
  const watcher = spawn(process.execPath, [cli, 'watch', '--force'], { cwd: tree, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500)); // watcher startup + initial reconcile
  const WATCH_REPS = 3;
  let watchStatus = 0;
  for (let i = 0; i < WATCH_REPS; i++) {
    touchMany(BULK_REPS + i);
    await new Promise((r) => setTimeout(r, 1500 + 1.5 * (bulkColdMs ?? 4000))); // debounce + background reparse, scaled to the measured reparse cost
    const r = timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter'], 1);
    bulkWatchSamples.push(r.ms);
    if (r.status !== 0) watchStatus = r.status;
  }
  bulkWatchMs = watchStatus === 0 ? medianOf(bulkWatchSamples) : null;
  watcher.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
} catch {}

const result = {
  tree: sourceTree,
  work_tree: tree,
  copy_ms: copyMs,
  store: store ?? 'sqlite',
  notes: mdFiles.length,
  cold_crawl_ms: coldStatus === 0 ? coldMs : `FAILED(exit ${coldStatus})`,
  cold_crawl_ms_samples: coldSamples,
  warmed_bytes: warmedBytes,
  version_canary_ms: versionCanary.status === 0 ? versionCanary.ms : null,
  warm_query_ms: warm?.ms ?? null,
  bm25_search_ms: search?.ms ?? null,
  find_ms: findR?.ms ?? null,
  find_row_tokens: findRowTokens,
  embed_supported: NEW_DIALECT,
  cold_embed_ms: coldEmbedAttempt.status === 0 ? coldEmbedAttempt.ms : null,
  cold_embed_error: coldEmbedAttempt.status === 0 ? undefined : coldEmbedAttempt.stderr.split('\n')[0],
  semantic_find_ms: semanticR?.ms ?? null,
  map_ms: mapR?.ms ?? null,
  map_tokens: mapR ? Math.round(mapR.bytes / 4) : null,
  peek_ms: peekR?.ms ?? null,
  peek_tokens: peekR ? Math.round(peekR.bytes / 4) : null,
  related_ms: relatedR?.ms ?? null,
  related_tokens: relatedR ? Math.round(relatedR.bytes / 4) : null,
  largest_note_tokens: Math.round(largest.size / 4),
  bulk_files: BULK,
  bulk_change_ms: bulkColdMs,
  bulk_change_ms_samples: bulkSamples,
  bulk_watch_ms: bulkWatchMs,
  bulk_watch_ms_samples: bulkWatchSamples,
  inproc,
};
console.log(JSON.stringify(result, null, 2));
writeOut(outArg, result);

// The copy exists only for this run; the cached corpus was never touched.
safeRmSync(tree, { recursive: true, force: true });
