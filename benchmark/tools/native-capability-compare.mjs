#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareNativeCapabilityArtifacts } from '../lib/native-capability-compare.mjs';
import { writeOut } from '../lib/out.mjs';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function usage() {
  console.error('usage: node benchmark/tools/native-capability-compare.mjs <sqlite.json> <duckdb.json> <turso.json> [--out FILE]');
  console.error(`each input must be a regular JSON file no larger than ${MAX_ARTIFACT_BYTES} bytes`);
}

let parsed;
try {
  parsed = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (parsed.values.help) {
  usage();
  process.exit(0);
}
if (parsed.positionals.length !== 3) {
  usage();
  process.exit(2);
}

let result;
try {
  const artifacts = [];
  for (const arg of parsed.positionals) {
    const path = resolve(arg);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`comparison input is not a regular file: ${path}`);
    if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`comparison input exceeds ${MAX_ARTIFACT_BYTES} bytes: ${path}`);
    artifacts.push(JSON.parse(readFileSync(path, 'utf8')));
  }
  result = compareNativeCapabilityArtifacts(artifacts);
} catch (error) {
  result = {
    schema: 'native-capability-comparison-v1',
    eligible: false,
    reasons: [`input preflight failed: ${error instanceof Error ? error.message : String(error)}`],
    stores: [],
    common_rows: {},
  };
}
if (parsed.values.out) writeOut(parsed.values.out, result);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.eligible ? 0 : 1;
