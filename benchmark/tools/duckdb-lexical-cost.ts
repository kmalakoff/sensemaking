#!/usr/bin/env node
// Bounded DuckDB lexical diagnostic. It writes raw samples under this checkout's private .tmp.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DUCKDB_LEXICAL_COST_METHOD_VERSION, runDuckdbLexicalCost } from '../lib/duckdb-lexical-cost.ts';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.ts';
import { writeOut } from '../lib/out.ts';
import { assertBuilt } from '../lib/require-build.ts';
import { identityHash } from '../lib/workload-identity.ts';

type DiagnosticResult = Awaited<ReturnType<typeof runDuckdbLexicalCost>>;
type DiagnosticProvenance = ReturnType<typeof fixedWorkProvenance>;
type StableIdentity = ReturnType<typeof stableFixedWorkIdentity>;
interface DiagnosticFields {
  environment: ReturnType<typeof readinessObservation>['environment'];
  readiness: ReturnType<typeof fixedWorkReadiness>;
  provenance: DiagnosticProvenance | { status: string };
}
type DiagnosticArtifact = DiagnosticFields & ((DiagnosticResult & { implementation_stability: { stable: boolean; before: StableIdentity; after: StableIdentity } }) | { schema: string; method_version: string; status: string; valid: false; errors: string[]; samples: [] });

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = join(ROOT, '.tmp', 'duckdb-lexical-cost');
const HARNESS_FILES = ['benchmark/lib/duckdb-lexical-cost.ts', 'benchmark/lib/fixed-work-measurement.ts', 'benchmark/lib/native-capability.ts', 'benchmark/lib/out.ts', 'benchmark/lib/quiet-machine.ts', 'benchmark/lib/require-build.ts', 'benchmark/lib/workload-identity.ts', 'benchmark/tools/duckdb-lexical-cost.ts'];

function usage() {
  console.error('usage: node benchmark/tools/duckdb-lexical-cost.ts [--out FILE]');
  console.error('Runs the fixed six- and 500-note DuckDB lexical diagnostic after clean-machine preflight.');
}

function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages);
  return [error instanceof Error ? `${error.name}: ${error.message}` : String(error)];
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

let artifact: DiagnosticArtifact;
const entry = readinessObservation();
let before: ReturnType<typeof fixedWorkProvenance> | undefined;
try {
  if (!entry.passed) throw new Error(`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`);
  assertBuilt();
  before = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: HARNESS_FILES, store: 'duckdb', nativeObservation: { status: 'deferred until native open' } });
  const [{ DuckDBInstance }, { createConnection }, { createLexicalIndex, prepareFts }, { registerFunctions }]: [typeof import('@duckdb/node-api'), typeof import('../../src/store/duckdb/connection.ts'), typeof import('../../src/store/duckdb/lexical.ts'), typeof import('../../src/store/duckdb/sql-functions.ts')] =
    await Promise.all([
      import('@duckdb/node-api'),
      import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'connection.js')).href),
      import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'lexical.js')).href),
      import(pathToFileURL(join(ROOT, 'dist', 'esm', 'store', 'duckdb', 'sql-functions.js')).href),
    ]);
  const result = await runDuckdbLexicalCost({ DuckDBInstance, createConnection, createLexicalIndex, prepareLexical: prepareFts, registerFunctions });
  const errors = [...result.errors];
  const exit = readinessObservation();
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
    method_version: DUCKDB_LEXICAL_COST_METHOD_VERSION,
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
