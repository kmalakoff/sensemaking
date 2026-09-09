#!/usr/bin/env node
// Measures shared snippet and line lookup work once, above every Store implementation.
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fixedWorkProvenance, fixedWorkReadiness, readinessObservation, stableFixedWorkIdentity } from '../lib/fixed-work-measurement.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import { writeOut } from '../lib/out.mjs';
import { assertBuilt } from '../lib/require-build.mjs';
import {
  SHARED_SNIPPET_CANDIDATES as CANDIDATES,
  SHARED_SNIPPET_CASES as CASES,
  SHARED_SNIPPET_EXPECTED as EXPECTED,
  SHARED_SNIPPET_FILES as FILES,
  SHARED_SNIPPET_REPETITIONS as REPETITIONS,
  SHARED_SNIPPET_HARNESS_FILES,
  SHARED_SNIPPET_SCHEMA,
  SHARED_SNIPPET_TERMS as TERMS,
  SHARED_SNIPPET_INPUTS as WORKLOAD_INPUTS,
} from '../lib/shared-snippet-contract.mjs';
import { identityHash } from '../lib/workload-identity.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST_SEARCH = join(ROOT, 'dist', 'esm', 'commands', 'search.js');

function usage() {
  console.error('usage: node benchmark/tools/shared-snippet.mjs [--out FILE]');
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (values.help) {
    usage();
    return 0;
  }

  const entry = readinessObservation();
  let artifact;
  let before;
  try {
    if (!entry.passed) throw new Error(`quiet-machine preflight refused on ${entry.environment.machine.platform}: load ${entry.load.load1}`);
    assertBuilt();
    before = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: SHARED_SNIPPET_HARNESS_FILES });
    const { computeSnippets, lineNumberAt } = await import(pathToFileURL(DIST_SEARCH).href);
    const samples = [];
    for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
      const started = performance.now();
      const observed = {};
      for (const { id, char_limit: charLimit, count_limit: countLimit } of CASES) {
        observed[id] = {};
        for (const path of CANDIDATES) {
          const text = FILES[path];
          const result = computeSnippets(text, TERMS, charLimit, countLimit);
          observed[id][path] = { snippets: result.snippets, line: lineNumberAt(text, result.offset) };
        }
      }
      const ms = performance.now() - started;
      if (identityHash(observed) !== identityHash(EXPECTED)) throw new Error(`repetition ${repetition}: expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(observed)}`);
      samples.push({ repetition, ms, observed });
    }
    const exit = readinessObservation();
    if (!exit.passed) throw new Error(`quiet-machine readiness lost: load ${exit.load.load1}`);
    const after = fixedWorkProvenance({ packageRoot: ROOT, harnessFiles: SHARED_SNIPPET_HARNESS_FILES });
    const beforeStable = stableFixedWorkIdentity(before, entry.environment);
    const afterStable = stableFixedWorkIdentity(after, exit.environment);
    if (identityHash(beforeStable) !== identityHash(afterStable)) throw new Error('implementation identity changed during measurement');
    const ordered = samples.map(({ ms }) => ms).sort((a, b) => a - b);
    artifact = {
      schema: SHARED_SNIPPET_SCHEMA,
      measure_version: MEASURE_VERSION,
      status: 'success',
      valid: true,
      scope: 'shared snippet and line lookup above Store, measured once; not cross-store work',
      repetitions: REPETITIONS,
      errors: [],
      workload: { inputs: WORKLOAD_INPUTS, fingerprint: identityHash(WORKLOAD_INPUTS) },
      expected: EXPECTED,
      samples,
      median_ms: ordered[Math.floor(ordered.length / 2)],
      readiness: fixedWorkReadiness(entry, exit),
      environment: exit.environment,
      provenance: after,
      implementation_stability: { stable: true, before: beforeStable, after: afterStable },
    };
  } catch (error) {
    artifact = {
      schema: SHARED_SNIPPET_SCHEMA,
      measure_version: MEASURE_VERSION,
      status: 'invalid',
      valid: false,
      errors: [error?.message ?? String(error)],
      workload: { inputs: WORKLOAD_INPUTS, fingerprint: identityHash(WORKLOAD_INPUTS) },
      repetitions: REPETITIONS,
      readiness: fixedWorkReadiness(entry, null),
      environment: entry.environment,
      provenance: before ?? { status: 'unavailable-before-build-or-import' },
    };
  }
  if (values.out) writeOut(values.out, artifact);
  console.log(JSON.stringify(artifact, null, 2));
  return artifact.valid ? 0 : 1;
}

process.exitCode = await main();
