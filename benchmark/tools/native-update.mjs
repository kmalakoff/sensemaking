#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import {
  NATIVE_UPDATE_COUNTS,
  NATIVE_UPDATE_HARNESS_FILES,
  NATIVE_UPDATE_MTIME_MS,
  NATIVE_UPDATE_NEXT_MTIME_MS,
  NATIVE_UPDATE_NOTES,
  NATIVE_UPDATE_REPETITIONS,
  NATIVE_UPDATE_SCHEMA,
  NATIVE_UPDATE_STORES,
  nativeUpdateInputs,
  nativeUpdatePath,
  nativeUpdatePaths,
  nativeUpdateText,
} from '../lib/native-update-contract.mjs';
import { writeOut } from '../lib/out.mjs';
import { assertBuilt } from '../lib/require-build.mjs';
import { identityHash } from '../lib/workload-identity.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST_INDEX = join(ROOT, 'dist', 'esm', 'index.js');
const TMP_ROOT = join(ROOT, '.tmp', 'native-update');

function usage() {
  console.error(`usage: node benchmark/tools/native-update.mjs --store ${NATIVE_UPDATE_STORES.join('|')} --changed ${NATIVE_UPDATE_COUNTS.join('|')} [--out FILE]`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function closeStorePreserving(handle, primaryError) {
  if (!handle) return primaryError;
  try {
    await handle.store.close();
    return primaryError;
  } catch (cleanupError) {
    return primaryError ? new Error(`${errorMessage(primaryError)}; cleanup: ${errorMessage(cleanupError)}`) : cleanupError;
  }
}

let values;
try {
  ({ values } = parseArgs({ options: { store: { type: 'string' }, changed: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (values.help) {
  usage();
  process.exit(0);
}
const store = values.store;
const changed = Number(values.changed);
if (!NATIVE_UPDATE_STORES.includes(store) || !NATIVE_UPDATE_COUNTS.includes(changed)) {
  usage();
  process.exit(2);
}

const inputs = nativeUpdateInputs(changed);
const expected = { changed_paths: nativeUpdatePaths(changed), notes: NATIVE_UPDATE_NOTES };
const entry = readinessObservation();
let before;
let artifact;
try {
  if (!entry.passed) throw new Error(`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`);
  assertBuilt();
  before = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: NATIVE_UPDATE_HARNESS_FILES, store, nativeObservation: { status: 'deferred until native open' } });
  const { open } = await import(pathToFileURL(DIST_INDEX).href);
  mkdirSync(TMP_ROOT, { recursive: true });
  const samples = [];
  let nativeObservation = null;
  for (let repetition = 1; repetition <= NATIVE_UPDATE_REPETITIONS; repetition++) {
    const tree = mkdtempSync(join(TMP_ROOT, `${store}-${changed}-`));
    let opened;
    let operationError;
    let cleanupError;
    try {
      for (let index = 0; index < NATIVE_UPDATE_NOTES; index++) {
        const path = join(tree, nativeUpdatePath(index));
        writeFileSync(path, nativeUpdateText(index));
        utimesSync(path, NATIVE_UPDATE_MTIME_MS / 1000, NATIVE_UPDATE_MTIME_MS / 1000);
      }
      const cfg = { ...inputs.config, baseDir: tree, store };
      let baseline;
      let baselineError;
      let initialBaselinePaths;
      try {
        baseline = await open(cfg);
        const initialBaseline = await baseline.store.lexical.query(inputs.queries.baseline.text, inputs.queries.baseline.options);
        initialBaselinePaths = initialBaseline.map(({ path }) => path).sort();
        if (identityHash(initialBaselinePaths) !== identityHash(nativeUpdatePaths(NATIVE_UPDATE_NOTES))) throw new Error('initial baseline lexical paths do not match all 260 authored notes');
      } catch (error) {
        baselineError = error;
      } finally {
        baselineError = await closeStorePreserving(baseline, baselineError);
      }
      if (baselineError) throw baselineError;
      for (let index = 0; index < changed; index++) {
        const path = join(tree, nativeUpdatePath(index));
        writeFileSync(path, nativeUpdateText(index, true));
        utimesSync(path, NATIVE_UPDATE_NEXT_MTIME_MS / 1000, NATIVE_UPDATE_NEXT_MTIME_MS / 1000);
      }
      const started = performance.now();
      opened = await open(cfg);
      const openMs = performance.now() - started;
      const versionQuery = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
      const version = await (await opened.store.prepare(versionQuery)).get();
      const observedNative = { version_query: versionQuery, version: version?.version ?? null, capabilities: [...opened.store.capabilities] };
      if (nativeObservation && identityHash(nativeObservation) !== identityHash(observedNative)) throw new Error('native observation changed between repetitions');
      nativeObservation = observedNative;
      const firstStarted = performance.now();
      const first = await opened.store.lexical.query(inputs.queries.changed.text, inputs.queries.changed.options);
      const firstLexicalMs = performance.now() - firstStarted;
      const warmStarted = performance.now();
      const warm = await opened.store.lexical.query(inputs.queries.changed.text, inputs.queries.changed.options);
      const warmLexicalMs = performance.now() - warmStarted;
      const firstPaths = first.map(({ path }) => path).sort();
      const warmPaths = warm.map(({ path }) => path).sort();
      if (identityHash(firstPaths) !== identityHash(expected.changed_paths) || identityHash(warmPaths) !== identityHash(expected.changed_paths)) throw new Error(`changed lexical paths do not match the authored set for ${changed} files`);
      const postUpdateBaseline = await opened.store.lexical.query(inputs.queries.baseline.text, inputs.queries.baseline.options);
      const postUpdateBaselinePaths = postUpdateBaseline.map(({ path }) => path).sort();
      if (identityHash(postUpdateBaselinePaths) !== identityHash(nativeUpdatePaths(NATIVE_UPDATE_NOTES))) throw new Error('post-update baseline lexical paths do not match all 260 authored notes');
      const count = Number((await (await opened.store.prepare('SELECT COUNT(*) AS n FROM frontmatter')).get())?.n);
      if (count !== NATIVE_UPDATE_NOTES) throw new Error(`expected ${NATIVE_UPDATE_NOTES} indexed notes, got ${count}`);
      samples.push({
        repetition,
        ms: openMs + firstLexicalMs + warmLexicalMs,
        open_ms: openMs,
        first_lexical_ms: firstLexicalMs,
        warm_lexical_ms: warmLexicalMs,
        note_count: count,
        initial_baseline_paths: initialBaselinePaths,
        first_updated_paths: firstPaths,
        warm_updated_paths: warmPaths,
        post_update_baseline_paths: postUpdateBaselinePaths,
        changed_paths: firstPaths,
      });
    } catch (error) {
      operationError = error;
    } finally {
      cleanupError = await closeStorePreserving(opened, operationError);
      opened = null;
      try {
        safeRmSync(tree, { recursive: true, force: true });
        if (existsSync(tree)) cleanupError = cleanupError ? new Error(`${errorMessage(cleanupError)}; cleanup: temporary tree remains: ${tree}`) : new Error(`temporary tree remains: ${tree}`);
      } catch (error) {
        cleanupError = cleanupError ? new Error(`${errorMessage(cleanupError)}; cleanup: ${errorMessage(error)}`) : error;
      }
    }
    if (cleanupError) throw cleanupError;
  }
  const exit = readinessObservation();
  if (!exit.passed) throw new Error(`quiet-machine readiness lost: load ${exit.load.load1}`);
  const after = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: NATIVE_UPDATE_HARNESS_FILES, store, nativeObservation });
  const beforeStable = stableFixedWorkIdentity(before, entry.environment);
  const afterStable = stableFixedWorkIdentity(after, exit.environment);
  if (identityHash(beforeStable) !== identityHash(afterStable)) throw new Error('implementation identity changed during measurement');
  const ordered = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  artifact = {
    schema: NATIVE_UPDATE_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: 'success',
    valid: true,
    errors: [],
    store,
    changed,
    repetitions: NATIVE_UPDATE_REPETITIONS,
    scope: 'warm native lexical updates on 260 identically authored notes; ranking and production hydration are excluded',
    workload: { inputs, fingerprint: identityHash(inputs) },
    expected,
    samples,
    median_ms: ordered[Math.floor(ordered.length / 2)],
    readiness: fixedWorkReadiness(entry, exit),
    environment: exit.environment,
    provenance: after,
    implementation_stability: { stable: true, before: beforeStable, after: afterStable },
  };
} catch (error) {
  artifact = {
    schema: NATIVE_UPDATE_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: 'invalid',
    valid: false,
    errors: [error?.message ?? String(error)],
    store,
    changed,
    repetitions: NATIVE_UPDATE_REPETITIONS,
    workload: { inputs, fingerprint: identityHash(inputs) },
    expected,
    readiness: fixedWorkReadiness(entry, null),
    environment: entry.environment,
    provenance: before ?? { status: 'unavailable-before-build-or-import' },
  };
}
if (values.out) writeOut(values.out, artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.valid ? 0 : 1;
