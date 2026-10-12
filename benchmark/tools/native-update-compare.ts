#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { compareNativeUpdateArtifacts } from '../lib/native-update-contract.ts';
import { writeOut } from '../lib/out.ts';

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

let values: { out?: string; help?: boolean };
let positionals: string[];
try {
  ({ values, positionals } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: true }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (values.help || positionals.length !== 3) {
  console.error('usage: node benchmark/tools/native-update-compare.ts sqlite.json duckdb.json turso.json [--out FILE]');
  console.error(`each input must be a regular JSON file no larger than ${MAX_ARTIFACT_BYTES} bytes`);
  process.exit(values.help ? 0 : 2);
}

let comparison: ReturnType<typeof compareNativeUpdateArtifacts> | { schema: string; status: string; valid: boolean; errors: unknown[] };
try {
  comparison = compareNativeUpdateArtifacts(
    positionals.map((input): unknown => {
      const path = resolve(input);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`comparison input is not a regular file: ${path}`);
      if (stat.size > MAX_ARTIFACT_BYTES) throw new Error(`comparison input exceeds ${MAX_ARTIFACT_BYTES} bytes: ${path}`);
      return JSON.parse(readFileSync(path, 'utf8'));
    })
  );
} catch (error) {
  comparison = { schema: 'native-update-threshold-comparison-v1', status: 'invalid', valid: false, errors: [(error as { message?: unknown } | null | undefined)?.message ?? String(error)] };
}
if (values.out) writeOut(values.out, comparison);
console.log(JSON.stringify(comparison, null, 2));
process.exitCode = comparison.valid ? 0 : 1;
