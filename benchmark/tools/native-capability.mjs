#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
// A small native-store diagnostic. It records operation timings and output facts, but does not
// add a benchmark row or decide whether one store is faster.
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_NATIVE_NOTES, DEFAULT_NATIVE_REPETITIONS, MAX_NATIVE_NOTES, NATIVE_CAPABILITY_CASES, NATIVE_CAPABILITY_READINESS_POLICY, NATIVE_CAPABILITY_SCHEMA, nativeCapabilityEnvironment, runNativeCapability } from '../lib/native-capability.mjs';
import { writeOut } from '../lib/out.mjs';
import { describeLoad, topProcesses } from '../lib/quiet-machine.mjs';
import { assertBuilt } from '../lib/require-build.mjs';
import { identityHash } from '../lib/workload-identity.mjs';

const ROOT = join(fileURLToPath(new URL('../..', import.meta.url)));
const DIST_INDEX = join(ROOT, 'dist', 'esm', 'index.js');
const DIST_DIMS = join(ROOT, 'dist', 'esm', 'embed', 'types.js');
const TMP_ROOT = join(ROOT, '.tmp', 'native-capability');

function usage() {
  console.error(`usage: node benchmark/tools/native-capability.mjs [--store sqlite|duckdb|turso] [--case ${NATIVE_CAPABILITY_CASES.join('|')}] [--notes N] [--out FILE]`);
  console.error(`--store defaults to sqlite; --notes accepts ${DEFAULT_NATIVE_NOTES}..${MAX_NATIVE_NOTES} and defaults to ${DEFAULT_NATIVE_NOTES}; each run uses ${DEFAULT_NATIVE_REPETITIONS} fresh repetitions`);
}

function numberOption(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      store: { type: 'string', default: 'sqlite' },
      case: { type: 'string', default: 'baseline' },
      notes: { type: 'string', default: String(DEFAULT_NATIVE_NOTES) },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: false,
  }));
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
const caseId = values.case;
const notes = numberOption(values.notes, 'notes', DEFAULT_NATIVE_NOTES, MAX_NATIVE_NOTES);
if (!NATIVE_CAPABILITY_CASES.includes(caseId)) {
  usage();
  console.error(`--case must be one of ${NATIVE_CAPABILITY_CASES.join(', ')}`);
  process.exit(2);
}

const environment = nativeCapabilityEnvironment();
const readinessPolicy = { ...NATIVE_CAPABILITY_READINESS_POLICY, fingerprint: identityHash(NATIVE_CAPABILITY_READINESS_POLICY) };
const readinessSupported = !NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(environment.machine.platform);
const entryLoad = loadavg();
const entryDescription = describeLoad(entryLoad[0], environment.machine.logical_cores, topProcesses());
const entryReadiness = { load1: entryLoad[0], load5: entryLoad[1], load15: entryLoad[2], supported: readinessSupported, passed: readinessSupported && !entryDescription.blocked };
if (!readinessSupported || entryDescription.blocked) {
  const readinessError = readinessSupported ? entryDescription.text : `quiet-machine readiness is unsupported on ${environment.machine.platform}`;
  const refused = {
    schema: NATIVE_CAPABILITY_SCHEMA,
    status: 'refused-preflight',
    store,
    case_id: caseId,
    notes,
    repetitions: DEFAULT_NATIVE_REPETITIONS,
    valid: false,
    errors: [`quiet-machine preflight refused: ${readinessError}`],
    samples: [],
    environment,
    readiness: { policy: readinessPolicy, environment: { entry: environment, exit: null }, entry: entryReadiness, exit: null },
    timing: { valid: false, entry: { load1: entryLoad[0], load5: entryLoad[1], load15: entryLoad[2] }, exit: null, error: readinessError },
  };
  if (values.out) writeOut(values.out, refused);
  console.log(JSON.stringify(refused, null, 2));
  process.exit(1);
}

mkdirSync(TMP_ROOT, { recursive: true });
let artifact;
try {
  assertBuilt();
  const [{ open, STORE_NAMES }, { STORE_DIMS }] = await Promise.all([import(pathToFileURL(DIST_INDEX).href), import(pathToFileURL(DIST_DIMS).href)]);
  if (!STORE_NAMES.includes(store)) throw new Error(`--store must be one of ${STORE_NAMES.join(', ')}`);
  const result = await runNativeCapability({ open, store, storeNames: STORE_NAMES, root: TMP_ROOT, packageRoot: ROOT, harnessRoot: ROOT, storeDims: STORE_DIMS, notes, repetitions: DEFAULT_NATIVE_REPETITIONS, caseId, environmentBefore: environment });
  if (identityHash(result.implementation_stability.before.environment) !== identityHash(environment)) {
    result.errors.push('readiness entry environment did not match native measurement start');
    result.valid = false;
  }
  const exitEnvironment = nativeCapabilityEnvironment();
  const exitLoad = loadavg();
  const exitReadinessSupported = !NATIVE_CAPABILITY_READINESS_POLICY.unsupported_platforms.includes(exitEnvironment.machine.platform);
  const exitDescription = describeLoad(exitLoad[0], exitEnvironment.machine.logical_cores, topProcesses());
  if (identityHash(result.environment) !== identityHash(exitEnvironment)) {
    result.errors.push('readiness exit environment did not match native measurement end');
    result.valid = false;
  }
  const timingValid = result.valid && exitReadinessSupported && !exitDescription.blocked;
  const exitReadiness = { load1: exitLoad[0], load5: exitLoad[1], load15: exitLoad[2], supported: exitReadinessSupported, passed: exitReadinessSupported && !exitDescription.blocked };
  artifact = {
    ...result,
    readiness: { policy: readinessPolicy, environment: { entry: environment, exit: exitEnvironment }, entry: entryReadiness, exit: exitReadiness },
    timing: {
      valid: timingValid,
      entry: { load1: entryLoad[0], load5: entryLoad[1], load15: entryLoad[2] },
      exit: { load1: exitLoad[0], load5: exitLoad[1], load15: exitLoad[2] },
      ...(timingValid ? {} : { error: result.valid ? exitDescription.text : 'correctness postcondition failed; timing is not valid' }),
    },
  };
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  artifact = {
    schema: NATIVE_CAPABILITY_SCHEMA,
    status: 'invalid-measurement',
    store,
    notes,
    repetitions: DEFAULT_NATIVE_REPETITIONS,
    valid: false,
    errors: [`native capability measurement failed: ${message}`],
    samples: [],
    environment,
    case_id: caseId,
    readiness: { policy: readinessPolicy, environment: { entry: environment, exit: null }, entry: entryReadiness, exit: null },
    timing: { valid: false, entry: { load1: entryLoad[0], load5: entryLoad[1], load15: entryLoad[2] }, exit: null, error: message },
  };
}
if (values.out) writeOut(values.out, artifact);
console.log(JSON.stringify(values.out ? { schema: artifact.schema, store: artifact.store, case_id: artifact.case_id, notes: artifact.notes, repetitions: artifact.repetitions, valid: artifact.valid, timing_valid: artifact.timing.valid, out: values.out, errors: artifact.errors } : artifact, null, 2));
process.exitCode = artifact.valid && artifact.timing.valid ? 0 : 1;
