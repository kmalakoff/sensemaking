#!/usr/bin/env node
// Measures production file/snippet/section hydration over fixed already-ranked candidates.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { FIXED_HYDRATION_CANDIDATES as CANDIDATE_ORDER, FIXED_HYDRATION_CASES as CASES, FIXED_HYDRATION_EXPECTED as EXPECTED_ROWS, FIXED_HYDRATION_SECTIONS as EXPECTED_SECTIONS, FIXED_HYDRATION_INPUTS, FIXED_HYDRATION_FILES as FIXTURE } from '../lib/fixed-hydration-workload.mjs';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import { NATIVE_HYDRATION_HARNESS_FILES, NATIVE_HYDRATION_REPETITIONS, NATIVE_HYDRATION_SCHEMA } from '../lib/native-hydration-compare.mjs';
import { writeOut } from '../lib/out.mjs';
import { assertBuilt } from '../lib/require-build.mjs';
import { identityHash } from '../lib/workload-identity.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST_INDEX = join(ROOT, 'dist', 'esm', 'index.js');
const DIST_SEARCH = join(ROOT, 'dist', 'esm', 'commands', 'search.js');
const TMP_ROOT = join(ROOT, '.tmp', 'native-hydration');
const STORES = ['sqlite', 'duckdb', 'turso'];

const QUERY_TERM = 'walrus';
const WORKLOAD_INPUTS = { ...FIXED_HYDRATION_INPUTS, operation: 'production hydration over fixed ordered candidates and caller snippet budgets' };

function usage() {
  console.error(`usage: node benchmark/tools/native-hydration.mjs [--store ${STORES.join('|')}] [--out FILE]`);
}

let values;
try {
  ({ values } = parseArgs({ options: { store: { type: 'string', default: 'sqlite' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
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
if (!STORES.includes(store)) {
  usage();
  console.error(`--store must be one of ${STORES.join(', ')}`);
  process.exit(2);
}

const entry = readinessObservation();
if (!entry.passed) {
  const refused = {
    schema: NATIVE_HYDRATION_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: 'refused-preflight',
    store,
    valid: false,
    errors: [`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`],
    workload: { inputs: WORKLOAD_INPUTS, fingerprint: identityHash(WORKLOAD_INPUTS) },
    readiness: fixedWorkReadiness(entry, null),
    environment: entry.environment,
    provenance: { status: 'unavailable-before-build-or-import' },
  };
  if (values.out) writeOut(values.out, refused);
  console.log(JSON.stringify(refused, null, 2));
  process.exit(1);
}

let provenanceBefore;
let open;
let hydrateSearchRows;
try {
  assertBuilt();
  provenanceBefore = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: NATIVE_HYDRATION_HARNESS_FILES, store, nativeObservation: { status: 'deferred until native open' } });
  [{ open }, { hydrateSearchRows }] = await Promise.all([import(pathToFileURL(DIST_INDEX).href), import(pathToFileURL(DIST_SEARCH).href)]);
} catch (error) {
  const invalid = {
    schema: NATIVE_HYDRATION_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: 'invalid',
    store,
    valid: false,
    errors: [error?.message ?? String(error)],
    workload: { inputs: WORKLOAD_INPUTS, fingerprint: identityHash(WORKLOAD_INPUTS) },
    readiness: fixedWorkReadiness(entry, null),
    environment: entry.environment,
    provenance: provenanceBefore ?? { status: 'unavailable-before-build-or-import' },
  };
  if (values.out) writeOut(values.out, invalid);
  console.log(JSON.stringify(invalid, null, 2));
  process.exit(1);
}

mkdirSync(TMP_ROOT, { recursive: true });

const errors = [];
const samples = [];
let nativeObservation = null;
for (let repetition = 1; repetition <= NATIVE_HYDRATION_REPETITIONS; repetition++) {
  const tree = mkdtempSync(join(TMP_ROOT, `${store}-`));
  const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null, store };
  let primaryError;
  let cleanupError;
  try {
    for (const [path, text] of Object.entries(FIXTURE)) writeFileSync(join(tree, path), text);
    const opened = await open(cfg);
    const openedStore = opened.store;
    let operationError;
    try {
      if (openedStore.name !== store) throw new Error(`opened store is ${openedStore.name}, expected ${store}`);
      const versionQuery = store === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
      const version = await (await openedStore.prepare(versionQuery)).get();
      const observedNative = { version_query: versionQuery, version: version?.version ?? null, capabilities: [...openedStore.capabilities] };
      if (nativeObservation && identityHash(nativeObservation) !== identityHash(observedNative)) throw new Error('native observation changed between repetitions');
      nativeObservation = observedNative;
      // Postcondition before timing eligibility (testing-standards: correctness before measurement):
      // the section this hydration will look up must be exactly the authored one, on every repetition.
      const sections = {};
      for (const path of Object.keys(FIXTURE)) {
        const stmt = await openedStore.prepare('SELECT start_line, end_line FROM sections WHERE "path" = ? ORDER BY start_line');
        const found = (await stmt.all(path)).map((r) => `L${r.start_line}-${r.end_line}`);
        sections[path] = found.length === 1 ? found[0] : found;
      }
      if (identityHash(sections) !== identityHash(EXPECTED_SECTIONS)) throw new Error(`repetition ${repetition}: sections ${JSON.stringify(sections)} do not match the authored fixture ${JSON.stringify(EXPECTED_SECTIONS)}`);

      const rowsByCase = {};
      const timingsMs = {};
      const matchedPaths = new Set(CANDIDATE_ORDER);
      const started = performance.now();
      for (const { id, char_limit: snippetCharLimit, count_limit: snippetCountLimit } of CASES) {
        const rows = CANDIDATE_ORDER.map((path) => ({ path }));
        const caseStarted = performance.now();
        await hydrateSearchRows(openedStore, cfg, rows, matchedPaths, QUERY_TERM, { snippetCharLimit, snippetCountLimit });
        timingsMs[id] = performance.now() - caseStarted;
        const observedOrder = rows.map((r) => r.path);
        if (identityHash(observedOrder) !== identityHash(CANDIDATE_ORDER)) throw new Error(`repetition ${repetition} ${id}: hydration reordered candidates: ${JSON.stringify(observedOrder)}`);
        rowsByCase[id] = Object.fromEntries(rows.map((r) => [r.path, { snippets: r.snippets, lines: r.lines }]));
        if (identityHash(rowsByCase[id]) !== identityHash(EXPECTED_ROWS[id])) throw new Error(`repetition ${repetition} ${id}: expected ${JSON.stringify(EXPECTED_ROWS[id])}, got ${JSON.stringify(rowsByCase[id])}`);
      }
      const ms = performance.now() - started;
      samples.push({ repetition, ms, timings_ms: timingsMs, candidate_order: CANDIDATE_ORDER, rows_by_case: rowsByCase, sections });
    } catch (error) {
      operationError = error;
    }
    let closeError;
    try {
      await openedStore.close();
    } catch (error) {
      closeError = error;
    }
    if (operationError || closeError) {
      const details = [operationError?.message ?? operationError, closeError ? `close: ${closeError?.message ?? closeError}` : null].filter(Boolean);
      throw new Error(details.join('; '), { cause: operationError ?? closeError });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      safeRmSync(tree, { recursive: true, force: true });
      if (existsSync(tree)) cleanupError = new Error(`temporary tree remains: ${tree}`);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryError || cleanupError) {
    const details = [primaryError ? (primaryError.message ?? String(primaryError)) : null, cleanupError ? `cleanup: ${cleanupError.message ?? String(cleanupError)}` : null].filter(Boolean).join('; ');
    errors.push(details);
    break; // stop at the first failure (testing-standards: stage the run, stop at the first failure)
  }
}

const exit = readinessObservation();
if (!exit.passed) errors.push(`quiet-machine readiness lost: load ${exit.load.load1}`);
let provenanceAfter;
try {
  provenanceAfter = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: NATIVE_HYDRATION_HARNESS_FILES, store, nativeObservation: nativeObservation ?? { status: 'unobserved' } });
} catch (error) {
  errors.push(`final provenance: ${error?.message ?? error}`);
  provenanceAfter = provenanceBefore;
}
const beforeStable = stableFixedWorkIdentity(provenanceBefore, entry.environment);
const afterStable = stableFixedWorkIdentity(provenanceAfter, exit.environment);
const implementationStable = identityHash(beforeStable) === identityHash(afterStable);
if (!implementationStable) errors.push('implementation identity changed during measurement');
const sortedMs = samples.map((s) => s.ms).sort((a, b) => a - b);
const mid = Math.floor(sortedMs.length / 2);
const medianMs = sortedMs.length > 0 ? (sortedMs.length % 2 === 0 ? (sortedMs[mid - 1] + sortedMs[mid]) / 2 : sortedMs[mid]) : null;

const artifact = {
  schema: NATIVE_HYDRATION_SCHEMA,
  measure_version: MEASURE_VERSION,
  status: errors.length === 0 && samples.length === NATIVE_HYDRATION_REPETITIONS ? 'success' : 'invalid',
  scope: "production search hydration (file read + shared snippet computation + section line-range lookup) on a fixed ordered candidate set; not the fixed-path SQL content read that native-capability.mjs's content_read row measures, and not the ranking cost above it",
  store,
  case_id: 'fixed-shapes-and-budgets',
  repetitions: NATIVE_HYDRATION_REPETITIONS,
  valid: errors.length === 0 && samples.length === NATIVE_HYDRATION_REPETITIONS,
  errors,
  workload: {
    inputs: WORKLOAD_INPUTS,
    fingerprint: identityHash(WORKLOAD_INPUTS),
  },
  expected: { sections: EXPECTED_SECTIONS, rows_by_case: EXPECTED_ROWS },
  samples,
  median_ms: medianMs,
  readiness: fixedWorkReadiness(entry, exit),
  environment: exit.environment,
  provenance: provenanceAfter,
  implementation_stability: { stable: implementationStable, before: beforeStable, after: afterStable },
};
if (values.out) writeOut(values.out, artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.valid ? 0 : 1);
