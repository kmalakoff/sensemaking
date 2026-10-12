#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { compareNativeHydrationArtifacts } from '../lib/native-hydration-compare.ts';
import { writeOut } from '../lib/out.ts';

function usage() {
  console.error('usage: node benchmark/tools/native-hydration-compare.ts <sqlite.json> <duckdb.json> <turso.json> [--out FILE]');
}

let artifact: ReturnType<typeof compareNativeHydrationArtifacts> | { schema: string; status: string; valid: boolean; errors: unknown[] };
let out: string | undefined;
try {
  const parsed = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  out = parsed.values.out;
  if (parsed.values.help) {
    usage();
    process.exit(0);
  }
  const paths = parsed.positionals.length === 0 && out ? ['sqlite', 'duckdb', 'turso'].map((store) => join(dirname(out as string), `native-hydration-${store}.json`)) : parsed.positionals;
  if (paths.length !== 3) throw new Error('exactly three artifacts are required');
  artifact = compareNativeHydrationArtifacts(paths.map((path): unknown => JSON.parse(readFileSync(path, 'utf8'))));
} catch (error) {
  artifact = { schema: 'native-hydration-comparison-v1', status: 'invalid', valid: false, errors: [(error as { message?: unknown } | null | undefined)?.message ?? String(error)] };
}
if (out) writeOut(out, artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.valid ? 0 : 1;
