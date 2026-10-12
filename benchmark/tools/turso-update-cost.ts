#!/usr/bin/env node
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Database } from '@tursodatabase/database';
import type { Capability, OpenResult, ResolvedConfig } from 'sensemaking';
import type { TursoFtsStrategy } from '../../src/store/turso/reconcile.ts';
import type { Connection } from '../../src/store/types.ts';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.ts';
import { MEASURE_VERSION } from '../lib/measure.ts';
import { NATIVE_UPDATE_MTIME_MS as INITIAL_MTIME, NATIVE_UPDATE_NOTES as NOTES, nativeUpdateInputs, nativeUpdatePaths, nativeUpdatePath as pathFor, nativeUpdateText as textFor, NATIVE_UPDATE_NEXT_MTIME_MS as UPDATED_MTIME } from '../lib/native-update-contract.ts';
import { writeOut } from '../lib/out.ts';
import { assertBuilt } from '../lib/require-build.ts';
import { cleanupTemporaryTree, closeForCleanup, combinedError } from '../lib/turso-update-cleanup.ts';
import { identityHash } from '../lib/workload-identity.ts';

interface Operations {
  open: typeof import('sensemaking')['open'];
  listFiles: typeof import('../../src/scan/list.ts')['listFiles'];
  parseFile: typeof import('../../src/scan/index.ts')['parseFile'];
  tursoApi: typeof import('../../src/store/turso/native.ts')['tursoApi'];
  CONNECT_OPTS: typeof import('../../src/store/turso/native.ts')['CONNECT_OPTS'];
  createConnection: typeof import('../../src/store/turso/connection.ts')['createConnection'];
  queryLexical: typeof import('../../src/store/turso/lexical.ts')['queryLexical'];
  reconcileTursoContentWithStrategy: typeof import('../../src/store/turso/reconcile.ts')['reconcileTursoContentWithStrategy'];
  withTransaction: typeof import('../../src/store/transaction.ts')['withTransaction'];
  BEGIN_WRITE: typeof import('../../src/store/transaction.ts')['BEGIN_WRITE'];
}
interface NativeObservation {
  version_query: string;
  version: unknown;
  capabilities: Capability[];
}
interface UpdateSample {
  repetition: number;
  position: number;
  strategy: TursoFtsStrategy;
  notes: number;
  changed: number;
  timings_ms: ReturnType<typeof observeConnection> & { total_ms: number };
  outputs: { initial_baseline_paths: string[]; updated_paths: string[]; baseline_paths: string[] };
  native_observation: NativeObservation;
}
interface UpdateArtifactFields {
  schema: string;
  measure_version: typeof MEASURE_VERSION;
  store: string;
  errors: string[];
  workload: { inputs: typeof INPUTS; fingerprint: string };
  samples: (UpdateSample | undefined)[];
  readiness: ReturnType<typeof fixedWorkReadiness>;
  environment: ReturnType<typeof readinessObservation>['environment'];
  provenance: ReturnType<typeof fixedWorkProvenance> | { status: string };
}
type UpdateArtifact = UpdateArtifactFields &
  (
    | {
        status: 'success';
        valid: true;
        scope: string;
        repetitions_per_strategy: number;
        alternating_order: string;
        timing_method: string;
        limitations: string[];
        expected: { changed_paths: string[]; baseline_paths: string[] };
        median_total_ms_by_strategy: Record<string, number>;
        implementation_stability: { stable: true; before: ReturnType<typeof stableFixedWorkIdentity>; after: ReturnType<typeof stableFixedWorkIdentity> };
      }
    | { status: 'invalid'; valid: false; native_observation: NativeObservation | null }
  );

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'dist', 'esm');
const TMP_ROOT = join(ROOT, '.tmp', 'turso-update-cost');
const CHANGED = 250;
const REPEATS = 3;
const INPUTS = {
  ...nativeUpdateInputs(CHANGED),
  measured_lexical_state: 'updated-marker and baseline postcondition queries after the measured direct content transaction on the same native connection',
};
const QUERY_OPTIONS = INPUTS.queries.baseline.options;
const STRATEGIES: TursoFtsStrategy[] = ['incremental', 'rebuild'];
const HARNESS_FILES = [
  'benchmark/lib/canonical-json.ts',
  'benchmark/lib/fixed-work-measurement.ts',
  'benchmark/lib/measure.ts',
  'benchmark/lib/native-capability.ts',
  'benchmark/lib/native-update-contract.ts',
  'benchmark/lib/out.ts',
  'benchmark/lib/quiet-machine.ts',
  'benchmark/lib/require-build.ts',
  'benchmark/lib/turso-update-cleanup.ts',
  'benchmark/lib/workload-identity.ts',
  'benchmark/tools/turso-update-cost.ts',
];

function samePaths(actual: readonly string[], expected: readonly string[], label: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} paths differ from the authored set`);
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return [...error.errors].flatMap(errorMessages);
  return [error instanceof Error ? error.message : String(error)];
}

function validDuration(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function assertTimings(timings: Readonly<Record<string, unknown>>) {
  for (const [name, value] of Object.entries(timings)) if (!validDuration(value)) throw new Error(`${name} is not a finite nonnegative duration`);
}

function usage() {
  console.error('usage: node benchmark/tools/turso-update-cost.ts [--out FILE]');
}

let values: { out?: string; help?: boolean };
try {
  ({ values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (values.help) {
  usage();
  process.exit(0);
}

function componentForExec(sql: string) {
  if (sql === 'BEGIN IMMEDIATE') return 'begin_ms';
  if (sql === 'COMMIT') return 'commit_ms';
  if (sql.startsWith('DROP INDEX')) return 'drop_ms';
  if (sql.startsWith('CREATE INDEX')) return 'create_ms';
  return 'other_exec_ms';
}

function componentForBatch(sql: string) {
  if (sql.startsWith('DELETE FROM content')) return 'delete_ms';
  if (sql.startsWith('INSERT INTO content')) return 'insert_ms';
  return 'other_batch_ms';
}

function observeConnection(conn: Connection) {
  const timings = { begin_ms: 0, drop_ms: 0, delete_ms: 0, insert_ms: 0, create_ms: 0, commit_ms: 0, other_exec_ms: 0, other_batch_ms: 0 };
  const exec = conn.exec.bind(conn);
  const runBatch = conn.runBatch.bind(conn);
  conn.exec = async (sql) => {
    const started = performance.now();
    try {
      await exec(sql);
    } finally {
      timings[componentForExec(sql)] += performance.now() - started;
    }
  };
  conn.runBatch = async (sql, rows) => {
    const started = performance.now();
    try {
      await runBatch(sql, rows);
    } finally {
      timings[componentForBatch(sql)] += performance.now() - started;
    }
  };
  return timings;
}

async function prepareTree(open: Operations['open']) {
  const tree = mkdtempSync(join(TMP_ROOT, 'run-'));
  const cfg: ResolvedConfig = { store: 'turso', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null };
  let baseline: OpenResult | undefined;
  let operationError: unknown;
  try {
    for (let index = 0; index < NOTES; index++) {
      const path = join(tree, pathFor(index));
      writeFileSync(path, textFor(index));
      utimesSync(path, INITIAL_MTIME / 1000, INITIAL_MTIME / 1000);
    }
    baseline = await open(cfg);
    const initialBaselinePaths = (await baseline.store.lexical.query(INPUTS.queries.baseline.text, QUERY_OPTIONS)).map(({ path }) => path).sort();
    samePaths(initialBaselinePaths, nativeUpdatePaths(NOTES), 'initial baseline');
    const prepared = { tree, cfg, dbPath: baseline.dbPath, capabilities: [...baseline.store.capabilities], initialBaselinePaths };
    await baseline.store.close();
    return prepared;
  } catch (error) {
    operationError = error;
  }
  const closed = await closeForCleanup(baseline, (handle) => handle.store.close());
  const cleanupError = combinedError(closed.error, cleanupTemporaryTree(tree, closed.released));
  throw combinedError(operationError, cleanupError);
}

async function runOne({ open, listFiles, parseFile, tursoApi, CONNECT_OPTS, createConnection, queryLexical, reconcileTursoContentWithStrategy, withTransaction, BEGIN_WRITE }: Operations, strategy: TursoFtsStrategy, repetition: number, position: number) {
  const prepared = await prepareTree(open);
  let db: Database | undefined;
  let result: UpdateSample | undefined;
  let operationError: unknown;
  try {
    const changed = nativeUpdatePaths(CHANGED);
    for (let index = 0; index < CHANGED; index++) {
      const path = join(prepared.tree, pathFor(index));
      writeFileSync(path, textFor(index, true));
      utimesSync(path, UPDATED_MTIME / 1000, UPDATED_MTIME / 1000);
    }
    const files = listFiles(prepared.cfg, prepared.tree);
    const changedSet = new Set(changed);
    const docs = files.filter((file) => changedSet.has(file.relPath)).map((file) => parseFile(file).doc);
    if (docs.length !== CHANGED) throw new Error(`expected ${CHANGED} parsed updates, got ${docs.length}`);

    const turso = await tursoApi();
    db = await turso.connect(prepared.dbPath, { ...CONNECT_OPTS, experimental: [...CONNECT_OPTS.experimental] });
    const conn = createConnection(db);
    const components = observeConnection(conn);
    const started = performance.now();
    await withTransaction(conn, () => reconcileTursoContentWithStrategy(conn, changed, docs, strategy), BEGIN_WRITE);
    const totalMs = performance.now() - started;
    const versionQuery = 'SELECT sqlite_version() AS version';
    const version = await (await conn.prepare(versionQuery)).get();
    const nativeObservation = { version_query: versionQuery, version: (version as { version?: unknown } | null | undefined)?.version ?? null, capabilities: prepared.capabilities };
    if (typeof nativeObservation.version !== 'string' || nativeObservation.version === '') throw new Error('native version observation is missing');
    const updated = (await queryLexical(conn, 'updated', QUERY_OPTIONS)).map(({ path }) => path).sort();
    const baseline = (await queryLexical(conn, 'baseline', QUERY_OPTIONS)).map(({ path }) => path).sort();
    samePaths(updated, changed, `${strategy} updated`);
    samePaths(baseline, nativeUpdatePaths(NOTES), `${strategy} baseline`);
    const timings = { ...components, total_ms: totalMs };
    assertTimings(timings);
    result = {
      repetition,
      position,
      strategy,
      notes: NOTES,
      changed: CHANGED,
      timings_ms: timings,
      outputs: { initial_baseline_paths: prepared.initialBaselinePaths, updated_paths: updated, baseline_paths: baseline },
      native_observation: nativeObservation,
    };
  } catch (error) {
    operationError = error;
  }
  const closed = await closeForCleanup(db, (handle) => handle.close());
  const cleanupError = combinedError(closed.error, cleanupTemporaryTree(prepared.tree, closed.released));
  const failure = combinedError(operationError, cleanupError);
  if (failure) throw failure;
  return result;
}

function median(values: readonly number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

const samples: (UpdateSample | undefined)[] = [];
const entry = readinessObservation();
let before: ReturnType<typeof fixedWorkProvenance> | undefined;
let nativeObservation: NativeObservation | undefined;
let artifact: UpdateArtifact;
try {
  if (!entry.passed) throw new Error(`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`);
  assertBuilt();
  mkdirSync(TMP_ROOT, { recursive: true });
  before = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: HARNESS_FILES, store: 'turso', nativeObservation: { status: 'deferred until native operation' } });
  const modules: [
    typeof import('sensemaking'),
    typeof import('../../src/scan/list.ts'),
    typeof import('../../src/scan/index.ts'),
    typeof import('../../src/store/turso/native.ts'),
    typeof import('../../src/store/turso/connection.ts'),
    typeof import('../../src/store/turso/lexical.ts'),
    typeof import('../../src/store/turso/reconcile.ts'),
    typeof import('../../src/store/transaction.ts'),
  ] = await Promise.all([
    import(pathToFileURL(join(DIST, 'index.js')).href),
    import(pathToFileURL(join(DIST, 'scan', 'list.js')).href),
    import(pathToFileURL(join(DIST, 'scan', 'index.js')).href),
    import(pathToFileURL(join(DIST, 'store', 'turso', 'native.js')).href),
    import(pathToFileURL(join(DIST, 'store', 'turso', 'connection.js')).href),
    import(pathToFileURL(join(DIST, 'store', 'turso', 'lexical.js')).href),
    import(pathToFileURL(join(DIST, 'store', 'turso', 'reconcile.js')).href),
    import(pathToFileURL(join(DIST, 'store', 'transaction.js')).href),
  ]);
  const [api, scanList, scan, native, connection, lexical, reconcile, transaction] = modules;
  const operations: Operations = {
    open: api.open,
    listFiles: scanList.listFiles,
    parseFile: scan.parseFile,
    tursoApi: native.tursoApi,
    CONNECT_OPTS: native.CONNECT_OPTS,
    createConnection: connection.createConnection,
    queryLexical: lexical.queryLexical,
    reconcileTursoContentWithStrategy: reconcile.reconcileTursoContentWithStrategy,
    withTransaction: transaction.withTransaction,
    BEGIN_WRITE: transaction.BEGIN_WRITE,
  };
  for (let repetition = 1; repetition <= REPEATS; repetition++) {
    const order = repetition % 2 === 1 ? STRATEGIES : [...STRATEGIES].reverse();
    for (const [position, strategy] of order.entries()) {
      const sample = await runOne(operations, strategy, repetition, position + 1);
      if (nativeObservation && identityHash((sample as { native_observation: NativeObservation }).native_observation) !== identityHash(nativeObservation)) throw new Error('native observation changed between strategy operations');
      nativeObservation = (sample as { native_observation: NativeObservation }).native_observation;
      samples.push(sample);
    }
  }
  for (const strategy of STRATEGIES) if (samples.filter((sample) => (sample as { strategy: TursoFtsStrategy }).strategy === strategy).length !== REPEATS) throw new Error(`${strategy} repetition coverage is incomplete`);
  const exit = readinessObservation();
  const after = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: HARNESS_FILES, store: 'turso', nativeObservation });
  const beforeStable = stableFixedWorkIdentity(before, entry.environment);
  const afterStable = stableFixedWorkIdentity(after, exit.environment);
  if (identityHash(beforeStable) !== identityHash(afterStable)) throw new Error('implementation identity changed during measurement');
  const medianTotalMs = Object.fromEntries(STRATEGIES.map((strategy) => [strategy, median(samples.filter((sample) => (sample as { strategy: TursoFtsStrategy }).strategy === strategy).map((sample) => (sample as { timings_ms: UpdateSample['timings_ms'] }).timings_ms.total_ms))]));
  artifact = {
    schema: 'turso-update-cost-v1',
    status: 'success',
    valid: true,
    errors: [],
    measure_version: MEASURE_VERSION,
    store: 'turso',
    scope: 'real Turso content-index operation only: both strategies at exactly 250 updates on separately prepared 260-note trees; outer reconcile is excluded',
    repetitions_per_strategy: REPEATS,
    alternating_order: 'incremental,rebuild; rebuild,incremental; incremental,rebuild',
    timing_method: 'wall-clock around forwarded production Connection.exec/runBatch calls and their outer transaction; component times include JavaScript dispatch and must not be summed as independent native timings',
    limitations: [
      'Preparation, parsing, outer reconcile orchestration, feature hooks, reader contention, and process-interruption behavior are outside the timed operation.',
      'The diagnostic invokes the production Turso content routine and transaction helper directly; it does not change the shipped threshold or establish an optimization decision.',
    ],
    workload: { inputs: INPUTS, fingerprint: identityHash(INPUTS) },
    expected: { changed_paths: nativeUpdatePaths(CHANGED), baseline_paths: nativeUpdatePaths(NOTES) },
    samples,
    median_total_ms_by_strategy: medianTotalMs,
    readiness: fixedWorkReadiness(entry, exit),
    environment: exit.environment,
    provenance: after,
    implementation_stability: { stable: true, before: beforeStable, after: afterStable },
  };
} catch (error) {
  artifact = {
    schema: 'turso-update-cost-v1',
    status: 'invalid',
    valid: false,
    errors: errorMessages(error),
    measure_version: MEASURE_VERSION,
    store: 'turso',
    workload: { inputs: INPUTS, fingerprint: identityHash(INPUTS) },
    samples,
    readiness: fixedWorkReadiness(entry, null),
    environment: entry.environment,
    provenance: before ?? { status: 'unavailable-before-build-or-import' },
    native_observation: nativeObservation ?? null,
  };
}
if (values.out) writeOut(values.out, artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.status === 'success' ? 0 : 1;
