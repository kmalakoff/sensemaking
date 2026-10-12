#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeOut } from '../lib/out.ts';
import { comparePortableQualityArtifacts, PORTABLE_QUALITY_STORES } from '../lib/portable-quality.ts';

function usage() {
  console.error('usage: node benchmark/tools/portable-quality-compare.ts [<store artifacts...>] [--out FILE]');
}

let artifact: ReturnType<typeof comparePortableQualityArtifacts> | { schema: string; status: string; valid: boolean; errors: unknown[] };
let out: string | undefined;
try {
  const parsed = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
  out = parsed.values.out;
  if (parsed.values.help) {
    usage();
    process.exit(0);
  }
  const prefix = out ? basename(out, '.json').replace(/-comparison$/, '') : null;
  const paths = parsed.positionals.length === 0 && out ? PORTABLE_QUALITY_STORES.map((store) => join(dirname(out as string), `${prefix}-${store}.json`)) : parsed.positionals;
  if (paths.length !== PORTABLE_QUALITY_STORES.length) throw new Error(`exactly ${PORTABLE_QUALITY_STORES.length} artifacts are required`);
  artifact = comparePortableQualityArtifacts(paths.map((path): unknown => JSON.parse(readFileSync(path, 'utf8'))));
} catch (error) {
  artifact = { schema: 'portable-quality-comparison-v1', status: 'invalid', valid: false, errors: [(error as { message?: unknown } | null | undefined)?.message ?? String(error)] };
}
if (out) writeOut(out, artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.valid ? 0 : 1;
