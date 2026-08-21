// Benchmark one package against one tree; prints a JSON row for BENCHMARKING.md. Wall-time
// metrics spawn the CLI (what an agent pays); in-process ones time the engine alone.
// usage: node benchmark/run.mjs <package-root> <notes-dir>
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS_NAMES, corpusPath } from './lib/corpus.mjs';
import { futureDate, median as sharedMedian, timedCli, walkMd } from './lib/measure.mjs';

const [pkgRootArg, treeArg] = process.argv.slice(2);
if (!pkgRootArg || !treeArg) {
  console.error('usage: node bench/run.mjs <package-root> <notes-dir|corpus-name>');
  process.exit(2);
}
// Absolute from the start: spawns below run with cwd set to the tree.
const pkgRoot = resolve(pkgRootArg);
// A known corpus name builds and caches itself (atomic, fetch-once) rather than needing a
// pre-materialized path; anything else is treated as a directory path.
const tree = CORPUS_NAMES.includes(treeArg) ? corpusPath(treeArg) : resolve(treeArg);
const cli = join(pkgRoot, 'bin', 'cli.js');

const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: tree, encoding: 'utf8', maxBuffer: 64e6 });

const timed = (args, runs = 5) => timedCli(() => run(args), runs);

const fail = (r) => (r.status === 0 ? r : null);

// Dialect detection: pre-rename packages have no `search` verb, so their --help never
// mentions it. Runs once; every row-mapping choice below reads off this one flag so old and
// new packages still land in the same JSON shape for compare.mjs.
const HELP = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout ?? '';
const NEW_DIALECT = /search/.test(HELP);
// Ad-hoc SQL was `query` until it became `sql`, which took the name back from the search
// sense of "query". Read off --help so one harness measures every generation.
const SQL_VERB = /\bsense sql\b/.test(HELP) ? 'sql' : 'query';
// Both rows must measure the same files, differing only in vector participation: two presets
// over one glob, so there is no config edit between rows to force a rebuild.
const TWO_SCOPES = JSON.stringify({
  version: 3,
  presets: { default: { include: ['**/*.md'] }, lexical: { include: ['**/*.md'], semantic: false } },
  queries: {},
});
// find_ms: lexical ranked search (BM25 + link fusion, no vectors) -- old dialect is
// already lexical-only, preset-era packages scope to the semantic:false preset above.
const lexicalArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--preset', 'lexical', '--k', k] : ['find', terms, '--k', k]);
// semantic_find_ms: vector-participating search -- old dialect opts in with --semantic,
// new dialect participates by default.
const vectorArgs = (terms, k = '10') => (NEW_DIALECT ? ['search', terms, '--k', k] : ['find', terms, '--semantic', '--k', k]);

// Largest note: peek target and the read-cost baseline. Also collect files for update benchmarks.
const mdFiles = walkMd(tree).map((rel) => ({ rel, size: statSync(join(tree, rel)).size }));
const largest = mdFiles.reduce((a, b) => (b.size > a.size ? b : a), { rel: null, size: 0 });

const SEARCH = `SELECT f.path, content.title, snippet(content, -1, '«', '»', '…', 10) AS hit FROM frontmatter f JOIN content ON content.path = f.path WHERE content MATCH ? ORDER BY bm25(content, 10.0, 5.0, 1.0) LIMIT 10`;

// --- wall-time (CLI) ---
if (NEW_DIALECT) writeFileSync(join(tree, 'sense.config.json'), TWO_SCOPES);
rmSync(join(tree, '.sense'), { recursive: true, force: true });
const cold = timed(['status'], 1); // first open = full crawl
const warm = fail(timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter']));
const search = fail(timed([SQL_VERB, SEARCH, 'the']));
const findR = fail(timed(lexicalArgs('the'), 3));
// Non-null only on embed-enabled trees (vectors pre-built by the first run). The delta
// vs find_ms is what vector participation pays per invocation: model load + query embed + scan.
const semanticR = fail(timed(vectorArgs('the'), 3));
const mapR = fail(timed(['map'], 3));
// A `find` row is an output contract like the map/peek token counts: a row is a reference,
// and its cost must not grow with the tree. Measured in json (the shape an agent parses),
// per row actually returned.
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
// related_ms: the similar-but-unlinked command. It scans every embedding chunk in the tree
// per call (semantic-search cost class), unlike peek's cheap local queries. Runs after the
// semantic search above, which has warmed the embeddings this scan reads.
const relatedR = fail(timed(['related', largest.rel], 3));

// --- in-process (library) ---
let inproc = null;
try {
  const lib = await import(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href);
  // open() takes an already-resolved config, not a file to migrate -- so the shape here has
  // to match this package's own dialect (v1 `scan` pre-rename, v3 `presets` since).
  const cfg = NEW_DIALECT ? { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null } : { scan: { include: ['**/*.md'] }, queries: {}, baseDir: tree, configPath: null };
  const openClose = () => {
    const t = process.hrtime.bigint();
    const { db } = lib.open(cfg);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    db.close();
    return ms;
  };
  const median = sharedMedian;
  const touch = (files) => {
    const future = futureDate();
    for (const f of files) utimesSync(join(tree, f.rel), future, future);
  };

  const noChange = median(openClose, 5);
  const touch1 = median(() => {
    touch(mdFiles.slice(0, 1));
    return openClose();
  }, 3);
  const modify10 = median(() => {
    for (const f of mdFiles.slice(0, 10)) appendFileSync(join(tree, f.rel), ' benchmark-edit');
    touch(mdFiles.slice(0, 10));
    return openClose();
  }, 3);
  rmSync(join(tree, '.sense'), { recursive: true, force: true });
  const t = process.hrtime.bigint();
  const { db } = lib.open(cfg);
  const coldBuild = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
  db.close();
  inproc = { cold_build_ms: coldBuild, open_nochange_ms: noChange, update_1_file_ms: touch1, update_10_files_ms: modify10 };
} catch (err) {
  inproc = { error: String(err.message ?? err).split('\n')[0] };
}

// --- bulk change (watch's scenario): touch many files, time the first query after ---
const BULK = Math.min(500, mdFiles.length);
const touchMany = () => {
  const future = new Date(Date.now() + 120_000 + Math.random() * 60_000);
  for (const f of mdFiles.slice(0, BULK)) utimesSync(join(tree, f.rel), future, future);
};
run([SQL_VERB, 'SELECT 1']); // warm the cache first
touchMany();
const bulkCold = fail(timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter'], 1));

// Same change with a watcher already running: it reparses in the background, so the
// first query pays only the freshness check.
let bulkWatch = null;
try {
  const watcher = spawn(process.execPath, [cli, 'watch', '--force'], { cwd: tree, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500)); // watcher startup + initial reconcile
  touchMany();
  await new Promise((r) => setTimeout(r, 1500 + 1.5 * (bulkCold?.ms ?? 4000))); // debounce + background reparse, scaled to the measured reparse cost
  bulkWatch = fail(timed([SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter'], 1));
  watcher.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
} catch {}

console.log(
  JSON.stringify(
    {
      tree,
      notes: mdFiles.length,
      cold_crawl_ms: cold.status === 0 ? cold.ms : `FAILED(exit ${cold.status})`,
      warm_query_ms: warm?.ms ?? null,
      bm25_search_ms: search?.ms ?? null,
      find_ms: findR?.ms ?? null,
      find_row_tokens: findRowTokens,
      semantic_find_ms: semanticR?.ms ?? null,
      map_ms: mapR?.ms ?? null,
      map_tokens: mapR ? Math.round(mapR.bytes / 4) : null,
      peek_ms: peekR?.ms ?? null,
      peek_tokens: peekR ? Math.round(peekR.bytes / 4) : null,
      related_ms: relatedR?.ms ?? null,
      related_tokens: relatedR ? Math.round(relatedR.bytes / 4) : null,
      largest_note_tokens: Math.round(largest.size / 4),
      bulk_files: BULK,
      bulk_change_ms: bulkCold?.ms ?? null,
      bulk_watch_ms: bulkWatch?.ms ?? null,
      inproc,
    },
    null,
    2
  )
);
