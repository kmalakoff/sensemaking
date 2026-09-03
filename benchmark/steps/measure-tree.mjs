// Benchmark one package against one tree; prints a JSON row for BENCHMARKING.md. Wall-time metrics spawn the CLI (what an agent pays); in-process ones time the engine alone.
// usage: node benchmark/steps/measure-tree.mjs <package-root> <notes-dir|corpus-name> [--store <name>] [--work <dir>] [--out <file>]
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from '../lib/corpus.mjs';
import { futureDate, MEASURE_VERSION, medianAsync, medianOf, timedCli, walkMd, warmFileCache } from '../lib/measure.mjs';
import { writeOut } from '../lib/out.mjs';
import { copyTree, ephemeralWorkTree } from '../lib/work-tree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// store: a config fact the harness writes into the tree. Pre-store packages have no `search` verb
// and read the config as-is, ignoring it, so every old column stays a valid sqlite measurement.
// work: where the measured copy goes, defaulting under this package's own .tmp/, not the tree's.
const {
  values: { store, work: workArg, out: outArg },
  positionals: [pkgRootArg, treeArg],
} = parseArgs({
  options: { store: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' } },
  allowPositionals: true,
});
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

// A run measures a private copy, never the cached corpus, which the in-place edits below would
// otherwise drift. Same mechanism as compare-versions.mjs and store-dump.mjs.
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

// Registered as soon as the copy exists, so a throw anywhere below still removes it: a hub copy is
// hundreds of MB, and the happy-path-only cleanup this replaces leaked one per failed run.
if (!workArg) process.on('exit', () => safeRmSync(tree, { recursive: true, force: true }));

const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: tree, encoding: 'utf8', maxBuffer: 64e6 });

const timed = (args, runs = 5) => timedCli(() => run(args), runs);

// A missing row reads as null either way, so the reason is recorded: an old version lacking a
// command and the working tree failing one must not look alike.
const errors = {};
const fail = (r, row) => {
  if (r.status === 0) return r;
  errors[row] = `exit ${r.status}: ${(r.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`;
  return null;
};

// Dialect detection: pre-rename packages have no `search` verb, so their --help never mentions it. Runs once.
// Every row-mapping choice below reads off this one flag, so old and new packages land in the same JSON shape for compare.mjs.
const HELP = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout ?? '';
const NEW_DIALECT = /search/.test(HELP);
// Ad-hoc SQL was `query` until it became `sql`, which took the name back from the search
// sense of "query". Read off --help so one harness measures every generation.
const SQL_VERB = /\bsense sql\b/.test(HELP) ? 'sql' : 'query';
// A preset naming `signals` fails config load on a package older than config v5, which would null
// every row rather than one. Probed in a child so the harness process is untouched before timing.
const CONFIG_VERSION = Number(spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href)}).then((m) => console.log(m.SUPPORTED_CONFIG_VERSION ?? 0), () => console.log(0))`], { encoding: 'utf8' }).stdout);
// Three presets over one glob, so every search row measures the same files and they differ only in
// which signals fire, with no config edit between them to force a rebuild.
const SCOPES = {
  version: 3,
  presets: {
    default: { include: ['**/*.md'] },
    lexical: { include: ['**/*.md'], semantic: false },
    ...(CONFIG_VERSION >= 5 ? { words: { include: ['**/*.md'], signals: { words: 1 } } } : {}),
  },
  queries: {},
};
// find_ms: lexical ranked search (BM25 + link fusion, no vectors) -- old dialect is
// already lexical-only, preset-era packages scope to the semantic:false preset above.
const lexicalArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--preset', 'lexical', '--k', k] : ['find', terms, '--k', k]);
// semantic_find_ms: vector-participating search -- old dialect opts in with --semantic,
// new dialect participates by default.
const vectorArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--k', k] : ['find', terms, '--semantic', '--k', k]);
// words_ms: the same ranked search with links off, so find_ms minus this row is what link
// expansion costs. Only the preset above can express it, so older packages measure nothing here.
const wordsArgs = (terms, k = '10') => ['search', terms, '--preset', 'words', '--k', k];

// version_canary_ms: bare Node startup plus argv parsing, no tree work at all -- the number
// BENCHMARKING.md's Interpreting section calls the canary for "startup got heavier".
const versionCanary = timed(['--version'], 5);

// Largest note: peek target and the read-cost baseline. Also collect files for update benchmarks.
const mdFiles = walkMd(tree).map((rel) => ({ rel, size: statSync(join(tree, rel)).size }));
const largest = mdFiles.reduce((a, b) => (b.size > a.size ? b : a), { rel: null, size: 0 });

const SEARCH = `SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10`;

// --- wall-time (CLI) ---
if (NEW_DIALECT) writeTreeConfig(tree, SCOPES, { store });
// Every timed row measures a warm file cache, identically in every sitting. "Cold" means the
// index is built from nothing, never that the disk is cold, which is not reproducible.
const warmedBytes = warmFileCache(tree);
// Median of 3, clearing .sense before each rep (PLAN.md 3.10: +21% same-code spread on one
// sample). The last rep leaves .sense built, which warm/search/find below reuse.
const COLD_REPS = 3;
const coldSamples = [];
let coldStatus = 0;
for (let i = 0; i < COLD_REPS; i++) {
  safeRmSync(join(tree, '.sense'), { recursive: true, force: true });
  const r = timed(['status'], 1); // first open = full crawl
  coldSamples.push(r.ms);
  if (r.status !== 0) coldStatus = r.status;
}
const coldMs = medianOf(coldSamples);
const warm = fail(timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter']), 'warm_query_ms');
const search = fail(timed([SQL_VERB, SEARCH, 'the']), 'bm25_search_ms');
const findR = fail(timed(lexicalArgs('the'), 3), 'find_ms');
const wordsR = CONFIG_VERSION >= 5 ? fail(timed(wordsArgs('the'), 3), 'words_ms') : null;
// Cold crawl and first embed in one process: the chunk handoff survives only within a single CLI
// invocation, and the `status` call above already reconciled and exited, discarding it.
safeRmSync(join(tree, '.sense'), { recursive: true, force: true });
const coldEmbedAttempt = timed(vectorArgs('the'), 1);
// Non-null only on embed-enabled trees (vectors pre-built by the run above). The delta
// vs find_ms is what vector participation pays per invocation: model load + query embed + scan.
const semanticR = fail(timed(vectorArgs('the'), 3), 'semantic_find_ms');
const mapR = fail(timed(['map'], 3), 'map_ms');
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
const peekR = fail(timed(['peek', largest.rel], 3), 'peek_ms');
// related_ms: the similar-but-unlinked command. Scans every embedding chunk in the tree per call (semantic-search cost class), unlike peek's cheap local queries.
// Runs after the semantic search above, which has warmed the embeddings this scan reads.
const relatedR = fail(timed(['related', largest.rel], 3), 'related_ms');
// path_ms: graph traversal from the first note to the largest, the anchor peek and related use. A
// pair with no path exhausts the reachable set, which is the traversal cost this row watches either way.
const pathFrom = mdFiles.find((f) => f.rel !== largest.rel) ?? largest;
const pathR = fail(timed(['path', pathFrom.rel, largest.rel], 3), 'path_ms');

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
  const coldBuildStages = [];
  for (let i = 0; i < COLD_BUILD_REPS; i++) {
    safeRmSync(join(tree, '.sense'), { recursive: true, force: true });
    const t = process.hrtime.bigint();
    const opened = await lib.open(cfg);
    coldBuildSamples.push(Math.round(Number(process.hrtime.bigint() - t) / 1e6));
    // Null on every version published before the stage vocabulary existed, so a reader can tell
    // "this build reported no stages" from "this stage measured zero". Never defaulted to {}.
    coldBuildStages.push(opened.stages ?? null);
    await (opened.store ?? opened.db).close();
  }
  const coldBuild = medianOf(coldBuildSamples);
  // The stages of the rep that produced the reported median, so the split and the total describe
  // the same run rather than being averaged across reps that never happened together.
  const stages = coldBuildStages[coldBuildSamples.indexOf(coldBuild)] ?? null;
  inproc = { cold_build_ms: coldBuild, cold_build_ms_samples: coldBuildSamples, stages, open_nochange_ms: noChange, update_1_file_ms: touch1, update_10_files_ms: modify10 };
} catch (err) {
  inproc = { error: String(err.message ?? err).split('\n')[0] };
}

// setup_ms: the CLI's warm query minus the in-process open of the same work -- what an invocation
// pays before doing any of it. Computed from the two rows above, never measured.
const setupMs = warm?.ms != null && typeof inproc?.open_nochange_ms === 'number' ? Math.round((warm.ms - inproc.open_nochange_ms) * 10) / 10 : null;

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

// The same change with a watcher running, which reparses in the background so the query pays only
// the freshness check. One watcher for all 3 reps: startup is not what this row measures.
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
  measure_version: MEASURE_VERSION,
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
  setup_ms: setupMs,
  bm25_search_ms: search?.ms ?? null,
  find_ms: findR?.ms ?? null,
  words_ms: wordsR?.ms ?? null,
  find_row_tokens: findRowTokens,
  embed_supported: NEW_DIALECT,
  cold_embed_ms: coldEmbedAttempt.status === 0 ? coldEmbedAttempt.ms : null,
  cold_embed_error: coldEmbedAttempt.status === 0 ? undefined : coldEmbedAttempt.stderr.split('\n')[0],
  semantic_find_ms: semanticR?.ms ?? null,
  map_ms: mapR?.ms ?? null,
  map_tokens: mapR ? Math.round(mapR.bytes / 4) : null,
  peek_ms: peekR?.ms ?? null,
  peek_tokens: peekR ? Math.round(peekR.bytes / 4) : null,
  path_ms: pathR?.ms ?? null,
  related_ms: relatedR?.ms ?? null,
  related_tokens: relatedR ? Math.round(relatedR.bytes / 4) : null,
  largest_note_tokens: Math.round(largest.size / 4),
  bulk_files: BULK,
  bulk_change_ms: bulkColdMs,
  bulk_change_ms_samples: bulkSamples,
  bulk_watch_ms: bulkWatchMs,
  bulk_watch_ms_samples: bulkWatchSamples,
  inproc,
  errors,
};
for (const [row, why] of Object.entries(errors)) console.error(`row ${row} produced no number: ${why}`);
console.log(JSON.stringify(result, null, 2));
writeOut(outArg, result);
