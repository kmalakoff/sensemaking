#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeOut } from '../lib/out.ts';
import type { RETAINED_QUALITY_SCOPE } from '../lib/retained-quality.ts';
import { inspectRetainedQuality } from '../lib/retained-quality.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const baselineVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version;
const record = await inspectRetainedQuality({ reportsDir: join(ROOT, 'benchmark', 'reports'), sittingsDir: join(ROOT, '.tmp', 'sittings'), baselineVersion: baselineVersion as string | null | undefined, currentRoot: ROOT });
writeOut(values.out, record);
console.log(
  record.valid
    ? `revalidated retained portable NFCorpus quality on ${(record.scope as Pick<typeof RETAINED_QUALITY_SCOPE, 'stores'>).stores.join(', ')} from ${(record.source as { report: unknown }).report} (${(record.source as { sitting: unknown }).sitting})`
    : `retained quality unavailable: ${record.errors.join('; ')}`
);
process.exitCode = record.valid ? 0 : 1;
