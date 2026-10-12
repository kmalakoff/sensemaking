// Benchmark one package against one tree; prints a JSON row for BENCHMARKING.md. Wall-time metrics spawn the CLI (what an agent pays); in-process ones time the engine alone.
// usage: node benchmark/steps/measure-tree.ts <package-root> <notes-dir|corpus-name> [--store <name>] [--work <dir>] [--out <file>]
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import type { Stages } from '../../src/store/stages.ts';
import type { Store } from '../../src/store/types.ts';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from '../lib/corpus.ts';
import { MEASURE_VERSION, medianAsync, medianOf, stdoutEvidence, structuredSearchEvidence, timedCli, verbsFrom, walkMd, warmFileCache } from '../lib/measure.ts';
import { startMeasuredWatcher } from '../lib/measured-watcher.ts';
import { waitForNativeIndex } from '../lib/native-observer.ts';
import { writeOut } from '../lib/out.ts';
import type { FileManifestEntry } from '../lib/work-tree.ts';
import { applyDeterministicMutation, captureFileManifest, captureMutationFiles, copyTree, deterministicMutationMtime, ephemeralWorkTree, fileManifestFingerprint, openVerified, verifyContentTransition, verifyFileManifest, verifyManifestContents, verifyRepeatFingerprint } from '../lib/work-tree.ts';
import { executionEvidence, implementationProvenance, logicalWorkloadIdentity, manifestIdentity } from '../lib/workload-identity.ts';

type CliArgs = readonly (string | null)[];
type TimedResult = ReturnType<typeof timedCli>;
type CliResult = ReturnType<typeof runAt>;
type TimedAttempt = TimedResult['repetitions'][number] & { attempt: number; decoded?: { count: number }; phase?: string };
interface Failure {
  message: unknown;
  repetitions?: unknown[];
}
type ErrorFields = { message?: unknown; repetitions?: unknown };
type MeasuredConfig = ReturnType<typeof cfgFor>;
type IndexHandle = Pick<Store, 'prepare' | 'close'>;
type MeasuredStages = Pick<Stages, 'totalMs' | 'spans'>;
type MeasuredOpened = ({ store: IndexHandle; db?: IndexHandle } | { store?: IndexHandle; db: IndexHandle }) & { stages?: MeasuredStages };
type MeasuredOpen = (config: MeasuredConfig) => Promise<MeasuredOpened>;
type VerifiedOpen = Awaited<ReturnType<typeof openVerified<MeasuredConfig, MeasuredStages>>>;
type ObserverPayload = Parameters<typeof waitForNativeIndex>[0];
type ObservedIndex = Awaited<ReturnType<typeof waitForNativeIndex>>;
type Watcher = ReturnType<typeof startMeasuredWatcher>;
type WatcherSnapshot = ReturnType<typeof watcherSnapshot>;
interface Preparation {
  copy_ms: number[];
  baseline_open_ms: number[];
}
interface InProcessResult {
  error?: unknown;
  cold_build_ms?: number;
  cold_build_ms_samples?: number[];
  stages?: MeasuredStages | null;
  unaccounted_ms?: number | null;
  open_nochange_ms?: number;
  update_1_file_ms?: number;
  update_1_file_stages?: MeasuredStages | null;
  update_10_files_ms?: number;
  update_10_files_stages?: MeasuredStages | null;
  repeat_state?: {
    source: unknown;
    canonical: { files: number; bytes: number; fingerprint: string; indexed_content_fingerprint?: string; preparation: unknown };
    open_nochange: unknown;
    update_1_file: unknown;
    update_10_files: unknown;
    cold_build: unknown;
  };
}
interface LexicalReadiness {
  status: string;
  method: string;
  query?: string;
  rows?: number;
  observer?: unknown;
  error?: unknown;
}
interface OutputContract {
  status: string;
  reason?: string;
  argv?: CliArgs;
  command_status?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
  bytes?: number;
  stdout_utf16_code_units?: number;
  stdout_sha256?: string;
  stdout_utf8_bytes?: number;
  stdout_text_status?: string;
  stdout?: string;
  paths?: string[];
  via?: unknown[];
  snippet_sha256?: (string[] | null)[];
}
interface WatcherFailure {
  phase: string;
  observed_at: string;
  reason: ReturnType<typeof thrownEvidence>;
  before_diagnostic: WatcherSnapshot;
}
interface WatcherEvidence {
  copy_ms: number;
  baseline_build_ms: number;
  watcher_preparation: ReturnType<typeof prepareWatcher>;
  baseline_observer: ReturnType<typeof compactObserver>;
  watcher_startup_ms?: number;
  started?: { event: Watcher['events'][number]; next: number; observed: WatcherSnapshot };
  reconcile_wait?: { started_at: string; events_after: number; finished_at?: string; elapsed_ms?: number };
  readiness_ms?: number;
  readiness_observer?: ReturnType<typeof compactObserver>;
  final_observer?: ReturnType<typeof compactObserver>;
  failure?: WatcherFailure;
  before_cleanup?: WatcherSnapshot;
  close?: { started_at: string; result?: Awaited<ReturnType<Watcher['close']>>; error?: ReturnType<typeof thrownEvidence>; observed?: WatcherSnapshot; finished_at: string };
  after_cleanup?: WatcherSnapshot;
}
interface BulkChangePreparation {
  copy_ms: number;
  baseline_build_ms: number;
  baseline_observer: ReturnType<typeof compactObserver>;
  final_observer: ReturnType<typeof compactObserver>;
}
interface BulkState {
  mutation: string;
  mutation_mtime_ms: number;
  paths: string[];
  observer: { kind: string; watcher_instrument: string; cache_warming: string; side_effects: string[] };
  change: { repetitions: number; preparation: BulkChangePreparation[]; verified?: boolean };
  watch: { repetitions: number; preparation: WatcherEvidence[]; verified?: boolean };
  canonical_indexed_content_fingerprint?: string | null;
  mutated_file_fingerprint?: string | null;
}
interface TimedOutput {
  status: string;
  repetitions?: TimedAttempt[];
  [key: string]: unknown;
}
interface RowExecution {
  argv: CliArgs;
  config_fingerprint: string | null;
  resolved_equivalence: string;
  timed_output?: TimedOutput;
  lexical_readiness?: LexicalReadiness;
  output_contract?: unknown;
}
type WorkloadRow = ReturnType<typeof logicalWorkloadIdentity> & { execution: RowExecution };
interface TimedPhase {
  label: string;
  source_cache: string;
  index_state: string;
  readiness: string;
  semantic_correctness: string;
  prior: string[];
  intervening?: string[];
}

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
const sourceTree = (CORPUS_NAMES.includes(treeArg as (typeof CORPUS_NAMES)[number]) ? corpusPath(treeArg) : resolve(treeArg)) as string;
const cli = join(pkgRoot, 'bin', 'cli.js');

// A run measures a private copy, never the cached corpus, which the in-place edits below would
// otherwise drift. Same mechanism as compare-versions.ts and store-dump.ts.
const copyStart = process.hrtime.bigint();
let tree: string;
if (workArg) {
  tree = resolve(workArg);
  mkdirSync(tree, { recursive: true });
  copyTree(sourceTree, tree);
} else {
  tree = ephemeralWorkTree(join(ROOT, '.tmp'), 'run-', sourceTree);
}
const copyMs = Math.round(Number(process.hrtime.bigint() - copyStart) / 1e6);

// Registered as soon as the copy exists, so a throw anywhere below still removes it: a hub copy
// is hundreds of MB, too costly to leave behind on a failed run.
if (!workArg) process.on('exit', () => safeRmSync(tree, { recursive: true, force: true }));

const runAt = (cwd: string, args: CliArgs) => spawnSync(process.execPath, [cli, ...args] as string[], { cwd, encoding: 'utf8', maxBuffer: 64e6 });
const run = (args: CliArgs) => runAt(tree, args);

const timedOutputs = new Map<string, TimedAttempt[]>();
const recordTimedOutput = (row: string, result: TimedResult) => {
  const prior = timedOutputs.get(row) ?? [];
  timedOutputs.set(row, prior.concat(result.repetitions.map((repetition, index) => ({ ...repetition, attempt: prior.length + index + 1 }))));
  return result;
};
const timed = (args: CliArgs, runs = 5, row: string | null = null) => {
  const result = timedCli(() => run(args), runs);
  return row ? recordTimedOutput(row, result) : result;
};

// A missing row reads as null either way, so the reason is recorded: an old version lacking a
// command and the working tree failing one must not look alike.
const errors: Record<string, Failure> = {};
const addError = (row: string, failure: Failure) => {
  const prior = errors[row];
  errors[row] = prior ? { message: `${prior.message}; ${failure.message}`, repetitions: [...(prior.repetitions ?? []), ...(failure.repetitions ?? [])] } : failure;
};
const fail = (r: TimedResult | null | undefined, row: string) => {
  if (r?.status === 0 && !r.error) return r;
  const failure = r?.error
    ? { ...r.error, repetitions: r.repetitions ?? r.error.repetitions ?? [] }
    : {
        message: `exit ${r?.status ?? 'null'}${r?.signal ? ` (${r.signal})` : ''}: ${(r?.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`,
        repetitions: r?.repetitions ?? [],
      };
  addError(row, failure);
  return null;
};

// Dialect detection: pre-rename packages have no `search` verb, so their --help never mentions it. Runs once.
// Every row-mapping choice below reads off this one flag, so old and new packages land in the same JSON shape for compare.mjs.
const HELP = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout ?? '';
const NEW_DIALECT = /search/.test(HELP);
// Every verb this package's CLI advertises. A verb this build lacks reads as an empty row, not a
// failure: map/peek/related/path route through verbRow below; sql/query and find/search keep
// their own dialect selection since NEW_DIALECT already tells them apart.
const VERBS = verbsFrom(HELP);
const verbRow = (verb: string, args: CliArgs, row: string, runs: number) => (VERBS.has(verb) ? fail(timed(args, runs, row), row) : null);
// Ad-hoc SQL was `query` until it became `sql`, which took the name back from the search
// sense of "query". Read off --help so one harness measures every generation.
const SQL_VERB = /\bsense sql\b/.test(HELP) ? 'sql' : 'query';
// A preset naming `signals` fails config load on a package older than config v5. Probed in a child;
// Number() of a crashed probe's empty stdout is NaN, indistinguishable from an old package (PLAN.md 3.63).
const configProbe = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href)}).then((m) => process.stdout.write(String(m.SUPPORTED_CONFIG_VERSION ?? 0)), (err) => { console.error(String(err?.stack ?? err)); process.exit(1); })`], { encoding: 'utf8' });
const configProbeReported = configProbe.status === 0 ? Number(configProbe.stdout) : NaN;
if (Number.isNaN(configProbeReported))
  addError('words_ms', { message: `config-version probe failed: exit ${configProbe.status}: ${(configProbe.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`, repetitions: [{ run: 1, status: configProbe.status, signal: configProbe.signal ?? null, stderr: configProbe.stderr ?? '' }] });
const CONFIG_VERSION = Number.isNaN(configProbeReported) ? 0 : configProbeReported;
// Two config dialects, not one pinned version, so the declared version and its preset shapes move
// together; the v5 branch also names `embed` itself, since skipping migration drops that side effect (PLAN.md 3.63).
const SCOPES =
  CONFIG_VERSION >= 5
    ? { version: CONFIG_VERSION, presets: { default: { include: ['**/*.md'] }, lexical: { include: ['**/*.md'], signals: { words: 1, links: 1 } }, words: { include: ['**/*.md'], signals: { words: 1 } } }, embed: { model: 'minishlab/potion-retrieval-32M', provider: 'static' }, queries: {} }
    : {
        version: 3,
        presets: {
          default: { include: ['**/*.md'] },
          lexical: { include: ['**/*.md'], semantic: false },
        },
        queries: {},
      };
const cfgFor = (baseDir: string) => (NEW_DIALECT ? { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, ...(store ? { store } : {}) } : { scan: { include: ['**/*.md'] }, queries: {}, baseDir, configPath: null });
// find_ms: lexical ranked search (BM25 + link fusion, no vectors) -- old dialect is
// already lexical-only, preset-era packages scope to the semantic:false preset above.
const lexicalArgs = (terms: string, k = '10') => (NEW_DIALECT ? ['search', terms, '--preset', 'lexical', '--k', k] : ['find', terms, '--k', k]);
// semantic_find_ms: vector-participating search -- old dialect opts in with --semantic,
// new dialect participates by default.
const vectorArgs = (terms: string, k = '10') => (NEW_DIALECT ? ['search', terms, '--k', k] : ['find', terms, '--semantic', '--k', k]);
// words_ms: a ranked search with links off. Its difference from find_ms is a derived workload
// diagnostic, not an isolated link-expansion cost. Older packages cannot express this preset.
const wordsArgs = (terms: string, k = '10') => ['search', terms, '--preset', 'words', '--k', k];
const COUNT_ARGS = [SQL_VERB, 'SELECT COUNT(*) AS n FROM frontmatter', '--format', 'json'];

// version_canary_ms: bare Node startup plus argv parsing, no tree work at all -- the number
// BENCHMARKING.md's Interpreting section calls the canary for "startup got heavier".
const versionCanary = fail(timed(['--version'], 5, 'version_canary_ms'), 'version_canary_ms');

// Largest note: peek target and the read-cost baseline. Also collect files for update benchmarks.
const mdPaths = walkMd(tree);
const sourceManifest = captureFileManifest(sourceTree);
const canonicalManifest = captureFileManifest(tree, mdPaths);
verifyManifestContents(canonicalManifest, sourceManifest, 'copied corpus');
verifyFileManifest(tree, canonicalManifest, 'copied corpus');
const mdFiles = canonicalManifest.map(({ rel, bytes: size }) => ({ rel, size }));
const largest = mdFiles.reduce<{ rel: string | null; size: number }>((a, b) => (b.size > a.size ? b : a), { rel: null, size: 0 });
const mutationMtimeMs = deterministicMutationMtime(canonicalManifest);

// --- wall-time (CLI) ---
if (NEW_DIALECT) writeTreeConfig(tree, SCOPES, { store });
// Every timed row measures a warm file cache, identically in every sitting. "Cold" means the
// index is built from nothing, never that the disk is cold, which is not reproducible.
const warmedBytes = warmFileCache(tree);
// Median of 3, clearing .sense before each rep (PLAN.md 3.10: +21% same-code spread on one
// sample). The last rep leaves .sense built, which warm/search/find below reuse.
const COLD_REPS = 3;
const coldSamples: number[] = [];
let coldFailed = false;
for (let i = 0; i < COLD_REPS; i++) {
  safeRmSync(join(tree, '.sense'), { recursive: true, force: true });
  // Status is observational. A core SQL query builds on both old and current packages,
  // without preparing document vectors, and gives an independently checkable result.
  const r = fail(timed(COUNT_ARGS, 1, 'cold_crawl_ms'), 'cold_crawl_ms');
  if (r) {
    try {
      const rows = JSON.parse(r.repetitions[0].stdout as string) as unknown;
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].n !== mdFiles.length) throw new Error(`cold crawl expected ${mdFiles.length} indexed notes, got ${JSON.stringify(rows)}`);
      coldSamples.push(r.ms as number);
    } catch (error) {
      addError('cold_crawl_ms', { message: `repetition ${i + 1}: ${(error as { message: unknown }).message}` });
      coldFailed = true;
    }
  } else coldFailed = true;
}
const coldMs = coldFailed ? null : medianOf(coldSamples);
const warm = fail(timed(COUNT_ARGS.slice(0, 2), 5, 'warm_query_ms'), 'warm_query_ms');
let lexicalReadiness: LexicalReadiness = { status: 'not-run', method: 'not-applicable' };
try {
  if (NEW_DIALECT && CONFIG_VERSION >= 5) {
    const readinessArgs = [...wordsArgs('the'), '--format', 'json'];
    const readinessRun = run(readinessArgs);
    if (readinessRun.status !== 0 || readinessRun.signal || readinessRun.error) throw new Error(`lexical readiness query failed: exit ${readinessRun.status ?? 'null'}${readinessRun.signal ? ` (${readinessRun.signal})` : ''}: ${(readinessRun.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`);
    const readinessRows: unknown = JSON.parse(readinessRun.stdout);
    if (!Array.isArray(readinessRows) || readinessRows.some((row) => !row || typeof row.path !== 'string')) throw new Error('lexical readiness query returned malformed JSON rows');
    const readinessPaths = readinessRows.map((row) => row.path);
    if (new Set(readinessPaths).size !== readinessPaths.length) throw new Error('lexical readiness query returned duplicate paths');
    const readinessPayload: ObserverPayload = { pkgRoot, store: store ?? 'sqlite', configPath: join(tree, 'sense.config.json'), manifest: canonicalManifest };
    if (store === 'duckdb') readinessPayload.lexical = { terms: 'the', limit: canonicalManifest.length, expected_paths: readinessPaths };
    const observed = await waitForNativeIndex(readinessPayload);
    lexicalReadiness = { status: 'verified', method: 'public lexical result plus native readiness observer', query: 'the', rows: readinessPaths.length, observer: observed.lexical ?? { state: 'public-result' } };
  } else {
    lexicalReadiness = { status: 'not-applicable', method: 'legacy package has no native search readiness seam' };
  }
} catch (err) {
  lexicalReadiness = { status: 'failed', method: 'public lexical result plus native readiness observer', error: (err as ErrorFields | null | undefined)?.message ?? String(err) };
  addError('find_ms', { message: lexicalReadiness.error, repetitions: [] });
  addError('words_ms', { message: lexicalReadiness.error, repetitions: [] });
}
// Readiness is a precondition, not part of either timed row. A failed proof leaves both lexical
// measurements absent so an unproven native state can never become a timing number.
const lexicalReadyForTiming = lexicalReadiness.status === 'verified' || lexicalReadiness.status === 'not-applicable';
const findR = lexicalReadyForTiming ? fail(timed(lexicalArgs('the'), 3, 'find_ms'), 'find_ms') : null;
const wordsR = CONFIG_VERSION >= 5 && lexicalReadyForTiming ? fail(timed(wordsArgs('the'), 3, 'words_ms'), 'words_ms') : null;
// Cold crawl and first embed in one process: the chunk handoff survives only within a single CLI
// invocation, and the `status` call above already reconciled and exited, discarding it.
safeRmSync(join(tree, '.sense'), { recursive: true, force: true });
const coldEmbedAttempt = fail(timed(vectorArgs('the'), 1, 'cold_embed_ms'), 'cold_embed_ms');
// Non-null only on embed-enabled trees (vectors pre-built by the run above). Its difference from
// find_ms is a derived workload diagnostic; candidates, model work, and downstream work can differ.
const semanticR = fail(timed(vectorArgs('the'), 3, 'semantic_find_ms'), 'semantic_find_ms');
const mapR = verbRow('map', ['map'], 'map_ms', 3);
// A `find` row is an output contract like the map/peek token counts: a row is a reference, and its cost must not grow with the tree.
// Measured in json (the shape an agent parses), per row actually returned.
let findRowOutputContract: OutputContract = { status: 'not-run', reason: 'output contract invocation did not complete' };
const findRowTokens = (() => {
  const argv = [...lexicalArgs('the'), '--format', 'json'];
  const out = run(argv);
  if (out.status !== 0) {
    const output = stdoutEvidence(out.stdout ?? '');
    findRowOutputContract = { status: 'failed', argv, command_status: out.status ?? null, signal: out.signal ?? null, ...output };
    addError('find_row_tokens', { message: `exit ${out.status}: ${(out.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`, repetitions: [{ run: 1, status: out.status, signal: out.signal ?? null, stderr: out.stderr ?? '', ...output }] });
    return null;
  }
  try {
    const structured = structuredSearchEvidence(out.stdout);
    findRowOutputContract = {
      status: 'recorded',
      argv,
      command_status: out.status ?? null,
      signal: out.signal ?? null,
      bytes: out.stdout.length,
      ...stdoutEvidence(out.stdout),
      ...structured,
    };
    return Math.round(out.stdout.length / 4 / structured.paths.length);
  } catch (err) {
    const output = stdoutEvidence(out.stdout ?? '');
    findRowOutputContract = { status: 'failed', argv, command_status: out.status ?? null, signal: out.signal ?? null, error: (err as ErrorFields | null | undefined)?.message ?? String(err), ...output };
    addError('find_row_tokens', { message: `token parse failed: ${(err as ErrorFields | null | undefined)?.message ?? err}`, repetitions: [{ run: 1, status: out.status, signal: out.signal ?? null, stderr: out.stderr ?? '', ...output }] });
    return null;
  }
})();
const peekR = verbRow('peek', ['peek', largest.rel], 'peek_ms', 3);
// related_ms: the similar-but-unlinked command. Scans every embedding chunk in the tree per call (semantic-search cost class), unlike peek's cheap local queries.
// Runs after the semantic search above, which has warmed the embeddings this scan reads.
const relatedR = verbRow('related', ['related', largest.rel], 'related_ms', 3);
// path_ms: graph traversal from the first note to the largest, the anchor peek and related use. A
// pair with no path exhausts the reachable set, which is the traversal cost this row watches either way.
const pathFrom = mdFiles.find((f) => f.rel !== largest.rel) ?? largest;
const pathR = verbRow('path', ['path', pathFrom.rel, largest.rel], 'path_ms', 3);

// --- in-process (library) ---
let inproc: InProcessResult | null = null;
const INPROC_APPEND = ' benchmark-edit';
try {
  const lib: unknown = await import(pathToFileURL(join(pkgRoot, 'dist', 'esm', 'index.js')).href);
  // open() takes an already-resolved config, not a file to migrate -- so the shape here has
  // to match this package's own dialect (v1 `scan` pre-rename, v3 `presets` since).
  const mutation = INPROC_APPEND;
  const onePaths = mdFiles.slice(0, 1).map(({ rel }) => rel);
  const tenPaths = mdFiles.slice(0, 10).map(({ rel }) => rel);
  const prep = {
    canonical: { copy_ms: null as number | null, baseline_open_ms: null as number | null },
    open_nochange: { copy_ms: [] as number[], baseline_open_ms: [] as number[] },
    update_1_file: { copy_ms: [] as number[], baseline_open_ms: [] as number[] },
    update_10_files: { copy_ms: [] as number[], baseline_open_ms: [] as number[] },
    cold_build: { copy_ms: [] as number[] },
  };
  const withFreshTree = async <Result>(label: string, fn: (tree: string, copyMs: number) => Result | Promise<Result>) => {
    const started = process.hrtime.bigint();
    const repTree = ephemeralWorkTree(join(ROOT, '.tmp'), 'inproc-', sourceTree);
    const copyMs = Number(process.hrtime.bigint() - started) / 1e6;
    try {
      verifyFileManifest(repTree, canonicalManifest, `${label} copied input`);
      return await fn(repTree, copyMs);
    } finally {
      safeRmSync(repTree, { recursive: true, force: true });
    }
  };
  const medianWithStages = async (fn: () => Promise<VerifiedOpen>, runs: number) => {
    const samples = [];
    const stagesByRun = [];
    for (let i = 0; i < runs; i++) {
      const { ms, stages } = await fn();
      samples.push(Math.round(ms));
      stagesByRun.push(stages);
    }
    const ms = medianOf(samples);
    return { ms, stages: stagesByRun[samples.indexOf(ms)] ?? null };
  };
  const canonicalState = await withFreshTree('canonical baseline', async (repTree, copyMs) => {
    prep.canonical.copy_ms = copyMs;
    const opened = await openVerified((lib as { open: MeasuredOpen }).open, cfgFor(repTree), canonicalManifest, { label: 'canonical indexed state' });
    prep.canonical.baseline_open_ms = opened.ms;
    return opened;
  });
  // Median of `runs`, keeping the stages of the rep that produced the median (same convention as
  // the cold build below): the split and the total describe the same run, never an average.
  const noChange = await medianAsync(async () => {
    return withFreshTree('no-change repetition', async (repTree, copyMs) => {
      prep.open_nochange.copy_ms.push(copyMs);
      const cfg = cfgFor(repTree);
      const baseline = await openVerified((lib as { open: MeasuredOpen }).open, cfg, canonicalManifest, { label: 'no-change fresh-index baseline' });
      prep.open_nochange.baseline_open_ms.push(baseline.ms);
      verifyContentTransition(canonicalState.snapshot, baseline.snapshot);
      const opened = await openVerified((lib as { open: MeasuredOpen }).open, cfg, canonicalManifest, { label: 'no-change indexed state' });
      verifyContentTransition(baseline.snapshot, opened.snapshot);
      return opened.ms;
    });
  }, 5);
  const runUpdate = (paths: string[], append: string | null, preparation: Preparation) => {
    return withFreshTree('update repetition', async (repTree, copyMs) => {
      preparation.copy_ms.push(copyMs);
      const cfg = cfgFor(repTree);
      const baseline = await openVerified((lib as { open: MeasuredOpen }).open, cfg, canonicalManifest, { label: 'update fresh-index baseline' });
      preparation.baseline_open_ms.push(baseline.ms);
      verifyContentTransition(canonicalState.snapshot, baseline.snapshot);
      const mutationFiles = captureMutationFiles(repTree, canonicalManifest, paths);
      const expected = applyDeterministicMutation(repTree, canonicalManifest, mutationFiles, { append, mtimeMs: mutationMtimeMs });
      const opened = await openVerified((lib as { open: MeasuredOpen }).open, cfg, expected, { label: 'update indexed state' });
      verifyContentTransition(baseline.snapshot, opened.snapshot, append === null ? [] : paths);
      return opened;
    });
  };
  let touchFingerprint: string | null = null;
  const touch1 = await medianWithStages(async () => {
    const opened = await runUpdate(onePaths, null, prep.update_1_file);
    touchFingerprint = verifyRepeatFingerprint(touchFingerprint, opened.snapshot.fingerprint as string, 'mtime-only update');
    return opened;
  }, 3);
  let modifyFingerprint: string | null = null;
  const modify10 = await medianWithStages(async () => {
    const opened = await runUpdate(tenPaths, mutation, prep.update_10_files);
    modifyFingerprint = verifyRepeatFingerprint(modifyFingerprint, opened.snapshot.fingerprint as string, 'append update');
    return opened;
  }, 3);
  // Median of 3, clearing .sense before each rep (same instrument-spread rationale as cold crawl).
  const COLD_BUILD_REPS = 3;
  const coldBuildSamples = [];
  const coldBuildStages = [];
  for (let i = 0; i < COLD_BUILD_REPS; i++) {
    const opened = await withFreshTree('cold-build repetition', async (repTree, copyMs) => {
      prep.cold_build.copy_ms.push(copyMs);
      const result = await openVerified((lib as { open: MeasuredOpen }).open, cfgFor(repTree), canonicalManifest, { label: 'cold-build indexed state' });
      verifyContentTransition(canonicalState.snapshot, result.snapshot);
      return result;
    });
    coldBuildSamples.push(Math.round(opened.ms));
    // Null on every version published before the stage vocabulary existed, so a reader can tell
    // "this build reported no stages" from "this stage measured zero". Never defaulted to {}.
    coldBuildStages.push(opened.stages);
  }
  const coldBuild = medianOf(coldBuildSamples);
  // The stages of the rep that produced the reported median, so the split and the total describe
  // the same run rather than being averaged across reps that never happened together.
  const stages = coldBuildStages[coldBuildSamples.indexOf(coldBuild)] ?? null;
  // Time no stage claims (src/store/stages.ts's unaccountedMs, recomputed here since Stages
  // carries the raw spans): a residual that grows across releases means the vocabulary stopped covering the build.
  const unaccountedMs = stages ? Math.round((stages.totalMs - Object.values(stages.spans).reduce((a, b) => a + b, 0)) * 10) / 10 : null;
  inproc = {
    cold_build_ms: coldBuild,
    cold_build_ms_samples: coldBuildSamples,
    stages,
    unaccounted_ms: unaccountedMs,
    open_nochange_ms: noChange,
    update_1_file_ms: touch1.ms,
    update_1_file_stages: touch1.stages,
    update_10_files_ms: modify10.ms,
    update_10_files_stages: modify10.stages,
    repeat_state: {
      source: { files: sourceManifest.length, bytes: sourceManifest.reduce((total, file) => total + file.bytes, 0), fingerprint: fileManifestFingerprint(sourceManifest) },
      canonical: { files: canonicalManifest.length, bytes: canonicalManifest.reduce((total, file) => total + file.bytes, 0), fingerprint: fileManifestFingerprint(canonicalManifest), indexed_content_fingerprint: canonicalState.snapshot.fingerprint, preparation: prep.canonical },
      open_nochange: { repetitions: 5, verified: true, baseline: 'fresh copy + unmeasured canonical open', preparation: prep.open_nochange, indexed_content_fingerprint: canonicalState.snapshot.fingerprint },
      update_1_file: { paths: onePaths, mutation: 'mtime-only', mutation_mtime_ms: mutationMtimeMs, repetitions: 3, verified: true, baseline: 'fresh copy + unmeasured canonical open', preparation: prep.update_1_file, indexed_content_fingerprint: touchFingerprint },
      update_10_files: { paths: tenPaths, mutation: 'fixed append + mtime', append: mutation, mutation_mtime_ms: mutationMtimeMs, repetitions: 3, verified: true, baseline: 'fresh copy + unmeasured canonical open', preparation: prep.update_10_files, indexed_content_fingerprint: modifyFingerprint },
      cold_build: { repetitions: COLD_BUILD_REPS, verified: true, baseline: 'fresh copy with no index', preparation: prep.cold_build },
    },
  };
} catch (err) {
  inproc = { error: String((err as { message?: unknown }).message ?? err).split('\n')[0] };
} finally {
  try {
    verifyFileManifest(sourceTree, sourceManifest, 'source corpus after in-process measurements');
  } catch (err) {
    const sourceError = String((err as { message?: unknown }).message ?? err).split('\n')[0];
    inproc = { error: inproc?.error ? `${inproc.error}; ${sourceError}` : sourceError };
  }
}

// setup_ms: the CLI's warm query minus the in-process open of the same work -- what an invocation
// pays before doing any of it. Computed from the two rows above, never measured.
const setupMs = warm?.ms != null && typeof inproc?.open_nochange_ms === 'number' ? Math.round((warm.ms - inproc.open_nochange_ms) * 10) / 10 : null;

// --- bulk change (watch's scenario): touch many files, time the first query after ---
const BULK = Math.min(500, mdFiles.length);
const BULK_PATHS = mdFiles.slice(0, BULK).map(({ rel }) => rel);
const BULK_REPS = 3;
const bulkSamples: number[] = [];
const bulkWatchSamples: number[] = [];
const bulkState: BulkState = {
  mutation: 'deterministic mtime-only',
  mutation_mtime_ms: mutationMtimeMs,
  paths: BULK_PATHS,
  observer: {
    kind: 'measured-package native dialect child',
    watcher_instrument: 'measured-package public runWatch child, stdin EOF shutdown',
    cache_warming: 'baseline, readiness and final observers scan native metadata/content outside the timed query',
    side_effects: ['connection setup/cache warming', 'sqlite WAL/functions', 'duckdb functions', 'turso WAL checkpoint on close'],
  },
  change: { repetitions: BULK_REPS, preparation: [] },
  watch: { repetitions: VERBS.has('watch') ? BULK_REPS : 0, preparation: [] },
};
const observerPayload = (repTree: string, manifest: readonly FileManifestEntry[], expectedContent: ObserverPayload['expectedContent'] = null): ObserverPayload => ({ pkgRoot, store: store ?? 'sqlite', configPath: join(repTree, 'sense.config.json'), manifest, expectedContent });
const compactObserver = ({ content: _content, ...observed }: ObservedIndex) => observed;
const thrownEvidence = (reason: unknown) => {
  if (reason === undefined) return { type: 'undefined' };
  if (reason === null) return { type: 'null' };
  if (reason instanceof Error) return { type: 'error', name: reason.name, message: reason.message, stack: reason.stack ?? null, code: (reason as Error & { code?: unknown }).code ?? null };
  return { type: typeof reason, value: String(reason) };
};
const thrownMessage = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const watcherSnapshot = (watcher: Watcher) => ({
  observed_at: new Date().toISOString(),
  events: watcher.events.map((event) => ({ ...event })),
  // the watcher command as its owned job reports it: running, and its exit once known
  child: {
    connected: watcher.job.running,
    exit_code: watcher.job.exited ? watcher.job.exited.code : null,
    signal_code: watcher.job.exited ? watcher.job.exited.signal : null,
  },
});
let bulkCanonicalFingerprint: string | null = null;
let bulkMutatedFileFingerprint: string | null = null;

const validateCount = (result: { stdout: string; repetitions?: unknown[] }, label: string) => {
  let rows: unknown;
  try {
    rows = JSON.parse(result.stdout);
  } catch (err) {
    const failure: Error & { repetitions?: unknown } = new Error(`${label} returned invalid JSON: ${(err as ErrorFields | null | undefined)?.message ?? err}`);
    failure.repetitions = result.repetitions;
    throw failure;
  }
  if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0]?.n) !== canonicalManifest.length) {
    const failure: Error & { repetitions?: unknown } = new Error(`${label} count mismatch: expected ${canonicalManifest.length}, got ${JSON.stringify(rows)}`);
    failure.repetitions = result.repetitions;
    throw failure;
  }
  return Number(rows[0].n);
};
const commandFailure = (result: CliResult, label: string, runNumber: number) => {
  if (result.status === 0 && !result.error) return;
  const failure: Error & { repetitions?: unknown } = new Error(`${label} failed: ${result.error?.message ?? `exit ${result.status ?? 'null'}${result.signal ? ` (${result.signal})` : ''}: ${(result.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`}`);
  failure.repetitions = [{ run: runNumber, status: result.status ?? null, signal: result.signal ?? null, stderr: result.stderr ?? '', error: result.error?.message ?? null }];
  throw failure;
};
const timedAt = (repTree: string, runNumber: number, row: string) => {
  let raw: CliResult | undefined;
  const result = timedCli(() => {
    raw = runAt(repTree, COUNT_ARGS);
    return raw;
  }, 1);
  for (const repetition of result.repetitions) repetition.run = runNumber;
  if (result.error?.repetitions) for (const repetition of result.error.repetitions) repetition.run = runNumber;
  recordTimedOutput(row, result);
  return { ...result, stdout: raw?.stdout ?? '' };
};
const requireTimed = <Result extends TimedResult>(result: Result, label: string): Result => {
  if (!result.error) return result;
  const err: Error & { repetitions?: unknown } = new Error(`${label} failed: ${result.error.message}`);
  err.repetitions = result.repetitions;
  throw err;
};
const recordTimedCount = (row: string, count: number) => {
  const repetition = timedOutputs.get(row)?.at(-1);
  if (!repetition) throw new Error(`${row} has no timed output repetition for its decoded count`);
  repetition.decoded = { count };
};
const freshBulkTree = async <Result>(label: string, fn: (tree: string, copyMs: number) => Result | Promise<Result>) => {
  const copyStarted = process.hrtime.bigint();
  const repTree = ephemeralWorkTree(join(ROOT, '.tmp'), 'bulk-', sourceTree);
  const copyMs = Number(process.hrtime.bigint() - copyStarted) / 1e6;
  try {
    verifyFileManifest(repTree, canonicalManifest, `${label} copied input`);
    writeTreeConfig(repTree, SCOPES, { store });
    return await fn(repTree, copyMs);
  } finally {
    safeRmSync(repTree, { recursive: true, force: true });
  }
};
const baselineBulk = async (repTree: string, runNumber: number) => {
  const buildStarted = process.hrtime.bigint();
  const baseline: CliResult & { repetitions?: unknown[] } = runAt(repTree, COUNT_ARGS);
  const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;
  baseline.repetitions = [{ run: runNumber, status: baseline.status ?? null, signal: baseline.signal ?? null, stderr: baseline.stderr ?? '', error: baseline.error?.message ?? null }];
  commandFailure(baseline, 'bulk baseline', runNumber);
  validateCount(baseline, 'bulk baseline');
  const observed = await waitForNativeIndex(observerPayload(repTree, canonicalManifest));
  if (!Array.isArray(observed.content)) throw new Error('bulk baseline observer returned no content identity');
  bulkCanonicalFingerprint = verifyRepeatFingerprint(bulkCanonicalFingerprint, observed.fingerprint as string, 'bulk canonical index');
  return { buildMs, observed };
};
// Prepare configured capabilities before watcher startup so bulk_watch_ms measures the warm
// watcher mtime update; cold/core rows retain their deliberate no-vector baseline.
const prepareWatcher = (repTree: string, runNumber: number) => {
  const args = VERBS.has('build') ? ['build'] : vectorArgs('the');
  const started = process.hrtime.bigint();
  const result = runAt(repTree, args);
  const preparation = {
    argv: args,
    elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6,
    status: result.status ?? null,
    signal: result.signal ?? null,
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
  if (result.status !== 0 || result.signal || result.error) {
    const failure: Error & { repetitions?: unknown } = new Error(`watch preparation failed: ${result.error?.message ?? `exit ${result.status ?? 'null'}${result.signal ? ` (${result.signal})` : ''}: ${(result.stderr ?? '').split('\n').find(Boolean) ?? 'no stderr'}`}`);
    failure.repetitions = [{ run: runNumber, ...preparation }];
    throw failure;
  }
  return preparation;
};
const mutateBulk = (repTree: string) => {
  const selected = new Set(BULK_PATHS);
  const files = canonicalManifest.filter(({ rel }) => selected.has(rel));
  return applyDeterministicMutation(repTree, canonicalManifest, files, { append: null, mtimeMs: mutationMtimeMs });
};

let bulkFailed = false;
for (let i = 0; i < BULK_REPS; i++) {
  try {
    await freshBulkTree(`bulk-change repetition ${i + 1}`, async (repTree, copyMs) => {
      const baseline = await baselineBulk(repTree, i + 1);
      const expected = mutateBulk(repTree);
      const result = requireTimed(timedAt(repTree, i + 1, 'bulk_change_ms'), 'timed bulk query');
      recordTimedCount('bulk_change_ms', validateCount(result, 'timed bulk query'));
      const final = await waitForNativeIndex(observerPayload(repTree, expected, baseline.observed.content));
      if (final.fingerprint !== baseline.observed.fingerprint) throw new Error(`bulk-change content fingerprint changed after an mtime-only mutation: expected ${baseline.observed.fingerprint}, got ${final.fingerprint}`);
      bulkMutatedFileFingerprint = verifyRepeatFingerprint(bulkMutatedFileFingerprint, fileManifestFingerprint(expected), 'bulk mutated files');
      verifyFileManifest(repTree, expected, 'bulk-change final filesystem');
      bulkSamples.push(result.ms as number);
      bulkState.change.preparation.push({ copy_ms: copyMs, baseline_build_ms: baseline.buildMs, baseline_observer: compactObserver(baseline.observed), final_observer: compactObserver(final) });
    });
  } catch (err) {
    bulkFailed = true;
    addError('bulk_change_ms', { message: `repetition ${i + 1}: ${(err as ErrorFields | null | undefined)?.message ?? err}`, repetitions: ((err as ErrorFields | null | undefined)?.repetitions as unknown[] | undefined) ?? [{ run: i + 1, status: null, signal: null, stderr: '' }] });
  }
}
let bulkColdMs = bulkFailed ? null : medianOf(bulkSamples);

let bulkWatchFailed = false;
if (VERBS.has('watch')) {
  for (let i = 0; i < BULK_REPS; i++) {
    try {
      await freshBulkTree(`bulk-watch repetition ${i + 1}`, async (repTree, copyMs) => {
        const baseline = await baselineBulk(repTree, i + 1);
        const watcherPreparation = prepareWatcher(repTree, i + 1);
        const watcher = startMeasuredWatcher({ pkgRoot, configPath: join(repTree, 'sense.config.json') });
        const watcherStarted = process.hrtime.bigint();
        const watcherEvidence: WatcherEvidence = {
          copy_ms: copyMs,
          baseline_build_ms: baseline.buildMs,
          watcher_preparation: watcherPreparation,
          baseline_observer: compactObserver(baseline.observed),
        };
        let phase = 'watcher-startup';
        let expected: FileManifestEntry[] | null = null;
        let reconcileWaitStarted: bigint | null = null;
        let operationFailed = false;
        let operationError: unknown;
        let closeFailed = false;
        let closeError: unknown;
        try {
          const started = await watcher.waitFor('started', 0);
          const startupMs = Number(process.hrtime.bigint() - watcherStarted) / 1e6;
          watcherEvidence.watcher_startup_ms = startupMs;
          watcherEvidence.started = { event: { ...started.event }, next: started.next, observed: watcherSnapshot(watcher) };
          phase = 'bulk-mutation';
          expected = mutateBulk(repTree);
          reconcileWaitStarted = process.hrtime.bigint();
          watcherEvidence.reconcile_wait = { started_at: new Date().toISOString(), events_after: started.next };
          phase = 'reconciled-event';
          await watcher.waitFor('reconciled', started.next);
          watcherEvidence.reconcile_wait.finished_at = new Date().toISOString();
          watcherEvidence.reconcile_wait.elapsed_ms = Number(process.hrtime.bigint() - reconcileWaitStarted) / 1e6;
          phase = 'readiness-observer';
          const observed = await waitForNativeIndex(observerPayload(repTree, expected, baseline.observed.content));
          if (observed.fingerprint !== baseline.observed.fingerprint) throw new Error(`bulk-watch content fingerprint changed after an mtime-only mutation: expected ${baseline.observed.fingerprint}, got ${observed.fingerprint}`);
          const readinessMs = Number(process.hrtime.bigint() - reconcileWaitStarted) / 1e6;
          watcherEvidence.readiness_ms = readinessMs;
          watcherEvidence.readiness_observer = compactObserver(observed);
          watcher.assertRunning();
          phase = 'timed-query';
          const result = requireTimed(timedAt(repTree, i + 1, 'bulk_watch_ms'), 'timed watcher query');
          recordTimedCount('bulk_watch_ms', validateCount(result, 'timed watcher query'));
          phase = 'final-observer';
          const final = await waitForNativeIndex(observerPayload(repTree, expected, baseline.observed.content));
          if (final.fingerprint !== observed.fingerprint) throw new Error(`bulk-watch final fingerprint changed after readiness: expected ${observed.fingerprint}, got ${final.fingerprint}`);
          watcherEvidence.final_observer = compactObserver(final);
          bulkMutatedFileFingerprint = verifyRepeatFingerprint(bulkMutatedFileFingerprint, fileManifestFingerprint(expected), 'bulk mutated files');
          watcher.assertRunning();
          verifyFileManifest(repTree, expected, 'bulk-watch final filesystem');
          bulkWatchSamples.push(result.ms as number);
          phase = 'complete';
        } catch (reason) {
          operationFailed = true;
          operationError = reason;
          if (watcherEvidence.reconcile_wait && reconcileWaitStarted !== null && watcherEvidence.reconcile_wait.elapsed_ms === undefined) {
            watcherEvidence.reconcile_wait.finished_at = new Date().toISOString();
            watcherEvidence.reconcile_wait.elapsed_ms = Number(process.hrtime.bigint() - reconcileWaitStarted) / 1e6;
          }
          watcherEvidence.failure = { phase, observed_at: new Date().toISOString(), reason: thrownEvidence(reason), before_diagnostic: watcherSnapshot(watcher) };
        } finally {
          watcherEvidence.before_cleanup = watcherSnapshot(watcher);
          const closeStartedAt = new Date().toISOString();
          try {
            watcherEvidence.close = { started_at: closeStartedAt, result: await watcher.close(), finished_at: new Date().toISOString() };
          } catch (closeReason) {
            closeFailed = true;
            closeError = closeReason;
            watcherEvidence.close = { started_at: closeStartedAt, error: thrownEvidence(closeReason), observed: watcherSnapshot(watcher), finished_at: new Date().toISOString() };
          }
          watcherEvidence.after_cleanup = watcherSnapshot(watcher);
          bulkState.watch.preparation.push(watcherEvidence);
        }
        if (operationFailed || closeFailed) {
          const failures = [];
          if (operationFailed) failures.push(operationError);
          if (closeFailed) failures.push(closeError);
          const messages = [];
          if (operationFailed) messages.push(`operation: ${thrownMessage(operationError)}`);
          if (closeFailed) messages.push(`cleanup: ${thrownMessage(closeError)}`);
          const combined: AggregateError & { repetitions?: unknown } = new AggregateError(failures, `bulk watcher ${phase} failed (${messages.join('; ')})`);
          combined.repetitions = (operationError as ErrorFields | null | undefined)?.repetitions;
          throw combined;
        }
      });
    } catch (err) {
      bulkWatchFailed = true;
      addError('bulk_watch_ms', { message: `repetition ${i + 1}: ${(err as ErrorFields | null | undefined)?.message ?? err}`, repetitions: ((err as ErrorFields | null | undefined)?.repetitions as unknown[] | undefined) ?? [{ run: i + 1, status: null, signal: null, stderr: '' }] });
    }
  }
}
let bulkWatchMs = VERBS.has('watch') && !bulkWatchFailed ? medianOf(bulkWatchSamples) : null;
bulkState.canonical_indexed_content_fingerprint = bulkCanonicalFingerprint;
bulkState.mutated_file_fingerprint = bulkMutatedFileFingerprint;
try {
  verifyFileManifest(sourceTree, sourceManifest, 'source corpus after bulk measurements');
} catch (err) {
  bulkFailed = true;
  bulkWatchFailed = VERBS.has('watch');
  bulkColdMs = null;
  bulkWatchMs = null;
  const failure = { message: (err as ErrorFields | null | undefined)?.message ?? String(err), repetitions: [] };
  addError('bulk_change_ms', failure);
  if (VERBS.has('watch')) addError('bulk_watch_ms', failure);
}
bulkState.change.verified = !bulkFailed;
bulkState.watch.verified = VERBS.has('watch') && !bulkWatchFailed;

const corpusBytes = manifestIdentity(sourceManifest);
const copiedState = manifestIdentity(canonicalManifest, { includeMtime: true });
const cliConfig = { ...SCOPES, ...(store ? { store } : {}) };
const inprocConfig = { ...cfgFor(tree), baseDir: '<private-tree>' };
const cliConfigEvidence = executionEvidence({ argv: [], config: cliConfig });
const inprocConfigEvidence = executionEvidence({ argv: [], config: inprocConfig });
const logicalConfig = ({ store: _store, baseDir: _baseDir, configPath: _configPath, ...config }: Record<string, unknown>) => config;
const requested = (preset: string | null = null, config = cliConfigEvidence) => ({ include: ['**/*.md'], preset, actual_config: logicalConfig(config.config as Record<string, unknown>) });
const rowIdentity = (key: string, operation: object, { argv = [], observesMtime = false, config = cliConfigEvidence, requestedInputs = null }: { argv?: CliArgs; observesMtime?: boolean; config?: typeof cliConfigEvidence; requestedInputs?: unknown } = {}) => {
  const logicalRequested = requestedInputs ?? requested(null, config);
  return {
    ...logicalWorkloadIdentity({ corpus: corpusBytes, operation: { row: key, ...operation }, requested: logicalRequested, ...(observesMtime ? { observableState: copiedState } : {}) }),
    execution: { argv, config_fingerprint: config.config_fingerprint, resolved_equivalence: config.resolved_equivalence },
  };
};
const lexicalArgv = lexicalArgs('the');
const wordsArgv = wordsArgs('the');
const vectorArgv = vectorArgs('the');
const workloadRows: Record<string, WorkloadRow> = {
  cold_crawl_ms: rowIdentity('cold_crawl_ms', { kind: 'cold-core-count', sql: COUNT_ARGS[1] }, { argv: COUNT_ARGS }),
  version_canary_ms: { ...logicalWorkloadIdentity({ corpus: null, operation: { row: 'version_canary_ms', kind: 'cli-canary' }, requested: {} }), execution: { argv: ['--version'], config_fingerprint: null, resolved_equivalence: 'not-applicable' } },
  cold_embed_ms: rowIdentity('cold_embed_ms', { kind: 'cold-vector-search', query: 'the', k: 10 }, { argv: vectorArgv, requestedInputs: requested('default') }),
  warm_query_ms: rowIdentity('warm_query_ms', { kind: 'sql', sql: COUNT_ARGS[1] }, { argv: COUNT_ARGS.slice(0, 2) }),
  find_ms: rowIdentity('find_ms', { kind: 'lexical-search', query: 'the', k: 10 }, { argv: lexicalArgv, requestedInputs: requested('lexical') }),
  words_ms: rowIdentity('words_ms', { kind: 'words-search', query: 'the', k: 10 }, { argv: wordsArgv, requestedInputs: requested('words') }),
  find_row_tokens: rowIdentity('find_row_tokens', { kind: 'lexical-search-output', query: 'the', k: 10, format: 'json' }, { argv: [...lexicalArgv, '--format', 'json'], requestedInputs: requested('lexical') }),
  semantic_find_ms: rowIdentity('semantic_find_ms', { kind: 'vector-participating-search', query: 'the', k: 10 }, { argv: vectorArgv, requestedInputs: requested('default') }),
  map_ms: rowIdentity('map_ms', { kind: 'map' }, { argv: ['map'], observesMtime: true }),
  map_tokens: rowIdentity('map_tokens', { kind: 'map-output' }, { argv: ['map'], observesMtime: true }),
  peek_ms: rowIdentity('peek_ms', { kind: 'peek', path: largest.rel }, { argv: ['peek', largest.rel] }),
  peek_tokens: rowIdentity('peek_tokens', { kind: 'peek-output', path: largest.rel }, { argv: ['peek', largest.rel] }),
  path_ms: rowIdentity('path_ms', { kind: 'path', from: pathFrom.rel, to: largest.rel }, { argv: ['path', pathFrom.rel, largest.rel] }),
  related_ms: rowIdentity('related_ms', { kind: 'related', path: largest.rel }, { argv: ['related', largest.rel] }),
  related_tokens: rowIdentity('related_tokens', { kind: 'related-output', path: largest.rel }, { argv: ['related', largest.rel] }),
  bulk_change_ms: rowIdentity('bulk_change_ms', { kind: 'bulk-mtime-update', paths: BULK_PATHS, mutation_mtime_ms: mutationMtimeMs }, { argv: COUNT_ARGS, observesMtime: true }),
  bulk_watch_ms: rowIdentity('bulk_watch_ms', { kind: 'bulk-mtime-update-with-watcher', paths: BULK_PATHS, mutation_mtime_ms: mutationMtimeMs, watcher_start: 'configured-capabilities-prepared', preparation_argv: VERBS.has('build') ? ['build'] : vectorArgs('the') }, { argv: COUNT_ARGS, observesMtime: true }),
  'inproc.cold_build_ms': rowIdentity('inproc.cold_build_ms', { kind: 'in-process-cold-open' }, { observesMtime: true, config: inprocConfigEvidence }),
  'inproc.open_nochange_ms': rowIdentity('inproc.open_nochange_ms', { kind: 'in-process-nochange-open' }, { observesMtime: true, config: inprocConfigEvidence }),
  'inproc.update_1_file_ms': rowIdentity('inproc.update_1_file_ms', { kind: 'in-process-mtime-update', paths: mdFiles.slice(0, 1).map(({ rel }) => rel), mutation_mtime_ms: mutationMtimeMs }, { observesMtime: true, config: inprocConfigEvidence }),
  'inproc.update_10_files_ms': rowIdentity('inproc.update_10_files_ms', { kind: 'in-process-content-update', paths: mdFiles.slice(0, 10).map(({ rel }) => rel), append: INPROC_APPEND, mutation_mtime_ms: mutationMtimeMs }, { observesMtime: true, config: inprocConfigEvidence }),
};
workloadRows.setup_ms = rowIdentity('setup_ms', { kind: 'derived-difference', operands: { warm_query_ms: workloadRows.warm_query_ms.fingerprint, 'inproc.open_nochange_ms': workloadRows['inproc.open_nochange_ms'].fingerprint } });
workloadRows['inproc.unaccounted_ms'] = rowIdentity('inproc.unaccounted_ms', { kind: 'derived-stage-residual', operand: workloadRows['inproc.cold_build_ms'].fingerprint }, { observesMtime: true, config: inprocConfigEvidence });

const timedRows = ['version_canary_ms', 'cold_crawl_ms', 'warm_query_ms', 'find_ms', 'words_ms', 'cold_embed_ms', 'semantic_find_ms', 'map_ms', 'peek_ms', 'path_ms', 'related_ms'];
const timedPhase: Record<string, TimedPhase> = {
  version_canary_ms: { label: 'startup-canary', source_cache: 'not-applicable', index_state: 'not-opened', readiness: 'not-applicable', semantic_correctness: 'not-applicable', prior: [] },
  cold_crawl_ms: { label: 'cold-core-build-and-count', source_cache: 'pre-read-before-wall-sequence', index_state: 'absent-before-attempt', readiness: coldFailed ? 'failed' : 'count-verified', semantic_correctness: 'authored-manifest-count', prior: [] },
  warm_query_ms: { label: 'count-after-crawl-attempts', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-crawl-attempts', readiness: 'unverified-after-count', semantic_correctness: 'table-output-unverified', prior: ['cold_crawl_ms'] },
  find_ms: { label: 'lexical-after-readiness-preflight', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-crawl-attempts', readiness: lexicalReadiness.status, semantic_correctness: 'table-output-unverified', prior: ['warm_query_ms'] },
  words_ms: { label: 'words-after-readiness-preflight', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-crawl-attempts', readiness: lexicalReadiness.status, semantic_correctness: 'table-output-unverified', prior: ['find_ms'] },
  cold_embed_ms: { label: 'cold-vector-search', source_cache: 'pre-read-before-wall-sequence', index_state: 'absent-before-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['words_ms'] },
  semantic_find_ms: { label: 'vector-after-cold-vector', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-cold-vector-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['cold_embed_ms'] },
  map_ms: { label: 'map-after-vector', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-cold-vector-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['semantic_find_ms'] },
  peek_ms: { label: 'peek-after-map', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-cold-vector-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['map_ms'], intervening: ['find_row_tokens'] },
  related_ms: { label: 'related-after-peek', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-cold-vector-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['peek_ms'] },
  path_ms: { label: 'path-after-related', source_cache: 'pre-read-before-wall-sequence', index_state: 'existing-after-cold-vector-attempt', readiness: 'unverified', semantic_correctness: 'table-output-unverified', prior: ['related_ms'] },
};
const priorRowEvidence = (keys: string[]) =>
  keys.map((row) => {
    const attempts = timedOutputs.get(row) ?? [];
    return {
      row,
      attempts: attempts.length,
      command_status: attempts.length === 0 ? 'not-run' : attempts.every((attempt) => attempt.status === 0 && !attempt.signal && !attempt.error) ? 'success' : 'failed',
      error: errors[row]?.message ?? null,
    };
  });
const interveningRowEvidence = (keys: string[]) =>
  keys.map((row) => {
    const contract = row === 'find_row_tokens' ? findRowOutputContract : null;
    const status = contract?.status ?? 'not-run';
    const hasCommandResult = (contract?.command_status !== null && contract?.command_status !== undefined) || Boolean(contract?.signal);
    return {
      row,
      command_status: !hasCommandResult ? 'not-run' : (contract as OutputContract).command_status === 0 && !(contract as OutputContract).signal ? 'success' : 'failed',
      output_contract_status: status,
      command_status_code: contract?.command_status ?? null,
      error: contract?.error ?? errors[row]?.message ?? null,
    };
  });
const repetitionPhase = (key: string, index: number) => {
  if (key === 'find_ms') return index === 0 ? 'first-lexical-after-count' : 'later-lexical-after-count';
  if (key === 'semantic_find_ms') return index === 0 ? 'first-vector-after-cold-vector' : 'later-vector-after-cold-vector';
  return timedPhase[key]?.label ?? 'unclassified';
};
const unavailableTimedReason = (key: string) => {
  if (key === 'words_ms' && CONFIG_VERSION < 5) return 'measured package cannot express the words-only preset';
  const verb = ({ map_ms: 'map', peek_ms: 'peek', path_ms: 'path', related_ms: 'related' } as Record<string, string | undefined>)[key];
  if (verb && !VERBS.has(verb)) return `measured package does not advertise ${verb}`;
  return 'timed command was not reached';
};
for (const key of timedRows) {
  const row = workloadRows[key];
  const repetitions = timedOutputs.get(key) ?? [];
  const phase = timedPhase[key];
  row.execution.timed_output = {
    status: repetitions.length > 0 ? 'recorded' : 'not-run',
    workload_fingerprint: row.fingerprint,
    argv: row.execution.argv,
    config_fingerprint: row.execution.config_fingerprint,
    observed_format: key === 'version_canary_ms' ? 'text' : key === 'cold_crawl_ms' ? 'json' : 'table',
    semantic_structure: key === 'version_canary_ms' ? 'plain-version-text' : key === 'cold_crawl_ms' ? 'count-only' : 'unavailable-for-table',
    process_scope: 'fresh CLI process per attempt',
    phase: phase ? { label: phase.label, state: { source_cache: phase.source_cache, index: phase.index_state }, readiness: phase.readiness, semantic_correctness: phase.semantic_correctness, prior_rows: priorRowEvidence(phase.prior), intervening_rows: interveningRowEvidence(phase.intervening ?? []) } : null,
    repetitions: repetitions.map((attempt, index) => ({ ...attempt, phase: repetitionPhase(key, index) })),
    ...(repetitions.length === 0 ? { reason: unavailableTimedReason(key) } : {}),
  };
}
for (const key of ['find_ms', 'words_ms']) workloadRows[key].execution.lexical_readiness = lexicalReadiness;
for (const key of ['bulk_change_ms', 'bulk_watch_ms']) {
  const row = workloadRows[key];
  const repetitions = timedOutputs.get(key) ?? [];
  row.execution.timed_output = {
    status: repetitions.length > 0 ? 'recorded' : 'not-run',
    workload_fingerprint: row.fingerprint,
    argv: row.execution.argv,
    config_fingerprint: row.execution.config_fingerprint,
    observed_format: 'json',
    semantic_structure: 'count-only',
    repetitions,
    ...(repetitions.length === 0 ? { reason: key === 'bulk_watch_ms' && !VERBS.has('watch') ? 'measured package does not advertise watch' : 'timed command was not reached' } : {}),
  };
}
workloadRows.find_row_tokens.execution.output_contract = {
  ...findRowOutputContract,
  workload_fingerprint: workloadRows.find_row_tokens.fingerprint,
  config_fingerprint: workloadRows.find_row_tokens.execution.config_fingerprint,
  semantic_structure: 'ordered paths, via values, and snippet hashes from this invocation only',
};
for (const [key, sourceKey] of [
  ['map_tokens', 'map_ms'],
  ['peek_tokens', 'peek_ms'],
  ['related_tokens', 'related_ms'],
]) {
  const source = workloadRows[sourceKey].execution.timed_output as TimedOutput;
  const repetition = (source.repetitions as TimedAttempt[]).at(-1);
  const sourceInvalid = (source.repetitions as TimedAttempt[]).some((attempt) => attempt.status !== 0 || attempt.signal || attempt.error);
  workloadRows[key].execution.output_contract = {
    status: repetition ? (sourceInvalid ? 'source-invalid' : 'derived-from-timed-output') : 'not-run',
    source_row: sourceKey,
    source_workload_fingerprint: workloadRows[sourceKey].fingerprint,
    source_attempt: repetition?.attempt ?? null,
    source_stdout_sha256: repetition?.stdout_sha256 ?? null,
    formula: 'rounded UTF-16 code units / 4',
  };
}
for (const key of ['inproc.cold_build_ms', 'inproc.open_nochange_ms', 'inproc.update_1_file_ms', 'inproc.update_10_files_ms']) workloadRows[key].execution.timed_output = { status: 'not-cli' };
workloadRows.setup_ms.execution.timed_output = { status: 'derived', operands: ['warm_query_ms', 'inproc.open_nochange_ms'] };
workloadRows['inproc.unaccounted_ms'].execution.timed_output = { status: 'derived', operands: ['inproc.cold_build_ms'] };

const nativeFunction = (store ?? 'sqlite') === 'duckdb' ? 'version()' : 'sqlite_version()';
const nativeVersionRun = run([SQL_VERB, `SELECT ${nativeFunction} AS version`, '--format', 'json']);
let nativeObservation: { function: string; value: string; status: number | null; error: unknown } = { function: nativeFunction, value: 'unknown', status: nativeVersionRun.status, error: null };
try {
  const rows: unknown = JSON.parse(nativeVersionRun.stdout);
  if (nativeVersionRun.status !== 0 || !Array.isArray(rows) || typeof rows[0]?.version !== 'string') throw new Error((nativeVersionRun.stderr ?? '').split('\n').find(Boolean) ?? 'version query returned no string value');
  nativeObservation = { ...nativeObservation, value: rows[0].version };
} catch (err) {
  nativeObservation = { ...nativeObservation, error: (err as ErrorFields | null | undefined)?.message ?? String(err) };
}
const provenance = implementationProvenance({
  packageRoot: pkgRoot,
  harnessRoot: ROOT,
  harnessFiles: ['benchmark/steps/measure-tree.ts', 'benchmark/lib/canonical-json.ts', 'benchmark/lib/corpus.ts', 'benchmark/lib/measure.ts', 'benchmark/lib/measured-watcher.ts', 'benchmark/lib/native-observer.ts', 'benchmark/lib/out.ts', 'benchmark/lib/work-tree.ts', 'benchmark/lib/workload-identity.ts'],
  store: store ?? 'sqlite',
  nativeObservation,
  modelObservation: { provider: NEW_DIALECT ? 'static' : 'unknown', model: NEW_DIALECT ? 'minishlab/potion-retrieval-32M' : 'unknown', revision: 'unknown', eligibility: 'unverified' },
});
const workloadIdentity = {
  version: 1,
  logical_inputs: { corpus_bytes: corpusBytes, rows: workloadRows },
  physical_state: { copied_corpus: copiedState, bulk_indexed_content_fingerprint: bulkCanonicalFingerprint, inproc_indexed_content_fingerprint: inproc?.repeat_state?.canonical?.indexed_content_fingerprint ?? null },
  execution: { configs: { cli: { ...cliConfigEvidence, path_binding: 'private tree cwd' }, inproc: { ...inprocConfigEvidence, path_binding: 'baseDir replaced with <private-tree>' } } },
  provenance,
};

const result = {
  measure_version: MEASURE_VERSION,
  tree: sourceTree,
  work_tree: tree,
  copy_ms: copyMs,
  workload_identity: workloadIdentity,
  store: store ?? 'sqlite',
  notes: mdFiles.length,
  cold_crawl_ms: coldMs,
  cold_crawl_ms_samples: coldSamples,
  warmed_bytes: warmedBytes,
  version_canary_ms: versionCanary?.ms ?? null,
  warm_query_ms: warm?.ms ?? null,
  setup_ms: setupMs,
  find_ms: findR?.ms ?? null,
  words_ms: wordsR?.ms ?? null,
  find_row_tokens: findRowTokens,
  embed_supported: NEW_DIALECT,
  cold_embed_ms: coldEmbedAttempt?.ms ?? null,
  cold_embed_error: coldEmbedAttempt ? undefined : (errors.cold_embed_ms?.message ?? String(errors.cold_embed_ms ?? 'unknown error')),
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
  bulk_state: bulkState,
  bulk_change_ms: bulkColdMs,
  bulk_change_ms_samples: bulkSamples,
  bulk_watch_ms: bulkWatchMs,
  bulk_watch_ms_samples: bulkWatchSamples,
  inproc,
  errors,
};
for (const [row, why] of Object.entries(errors)) console.error(`row ${row} produced no number: ${why?.message ?? why}`);
console.log(JSON.stringify(result, null, 2));
writeOut(outArg, result);
