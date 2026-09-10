#!/usr/bin/env node
// Bounded DuckDB lexical diagnostic. It writes raw samples under this checkout's private .tmp.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runDuckdbLexicalCost } from '../lib/duckdb-lexical-cost.mjs';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.mjs';
import { writeOut } from '../lib/out.mjs';
import { assertBuilt } from '../lib/require-build.mjs';
import { identityHash } from '../lib/workload-identity.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = join(ROOT, '.tmp', 'duckdb-lexical-cost');
const HARNESS_FILES = [
  'benchmark/lib/duckdb-lexical-cost.mjs',
  'benchmark/lib/fixed-work-measurement.mjs',
  'benchmark/lib/native-capability.mjs',
  'benchmark/lib/out.mjs',
  'benchmark/lib/quiet-machine.mjs',
  'benchmark/lib/require-build.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/tools/duckdb-lexical-cost.mjs',
];

function usage() {
  console.error('usage: node benchmark/tools/duckdb-lexical-cost.mjs [--out FILE]');
  console.error('Runs the fixed six- and 500-note DuckDB lexical diagnostic after clean-machine preflight.');
}

function errorMessages(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages);
  return [error instanceof Error ? `${error.name}: ${error.message}` : String(error)];
}

let values;
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

let artifact;
const entry = readinessObservation();
let before;
try {
  if (!entry.passed) throw new Error(`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`);
  assertBuilt();
  before = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: HARNESS_FILES, store: 'duckdb', nativeObservation: { status: 'deferred until native open' } });
  const [{ DuckDBInstance }, { createConnection }, { createLexicalIndex }, { registerFunctions }] = await Promise.all([
    import('@duckdb/node-api'),
    import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'connection.js')).href),
    import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'lexical.js')).href),
    import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'sql-functions.js')).href),
  ]);
  const result = await runDuckdbLexicalCost({ DuckDBInstance, createConnection, createLexicalIndex, registerFunctions });
  const errors = [...result.errors];
  const exit = readinessObservation();
  if (!exit.passed) errors.push(`quiet-machine readiness lost: load ${exit.load.load1}`);
  const nativeObservations = result.samples.filter((sample) => sample.native).map((sample) => sample.native);
  if (nativeObservations.length !== result.samples.length || new Set(nativeObservations.map(identityHash)).size !== 1) errors.push('native version observation changed or was missing during measurement');
  const native = nativeObservations[0] ?? { version_query: 'SELECT version() AS version', version: 'unobserved' };
  const after = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: HARNESS_FILES, store: 'duckdb', nativeObservation: native });
  const beforeStable = stableFixedWorkIdentity(before, entry.environment);
  const afterStable = stableFixedWorkIdentity(after, exit.environment);
  const stable = identityHash(beforeStable) === identityHash(afterStable);
  if (!stable) errors.push('implementation identity changed during measurement');
  artifact = {
    ...result,
    status: errors.length === 0 ? 'success' : 'invalid-measurement',
    valid: errors.length === 0,
    errors,
    environment: exit.environment,
    readiness: fixedWorkReadiness(entry, exit),
    implementation_stability: { stable, before: beforeStable, after: afterStable },
    provenance: after,
  };
} catch (error) {
  artifact = {
    schema: 'duckdb-lexical-cost-v1',
    status: entry.passed ? 'invalid-measurement' : 'refused-preflight',
    valid: false,
    errors: errorMessages(error),
    samples: [],
    environment: entry.environment,
    readiness: fixedWorkReadiness(entry, null),
    provenance: before ?? { status: 'unavailable-before-build-or-import' },
  };
}

const out = values.out ?? join(OUT_DIR, `duckdb-lexical-cost-${Date.now()}.json`);
mkdirSync(OUT_DIR, { recursive: true });
writeOut(out, artifact);
console.log(JSON.stringify({ schema: artifact.schema, status: artifact.status, valid: artifact.valid, samples: artifact.samples.length, out, errors: artifact.errors }, null, 2));
process.exitCode = artifact.valid ? 0 : 1;
