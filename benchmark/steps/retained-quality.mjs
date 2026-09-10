#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeOut } from '../lib/out.mjs';
import { inspectRetainedQuality } from '../lib/retained-quality.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
const baselineVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const record = await inspectRetainedQuality({ reportsDir: join(ROOT, 'benchmark', 'reports'), sittingsDir: join(ROOT, '.tmp', 'sittings'), baselineVersion, currentRoot: ROOT });
writeOut(values.out, record);
console.log(record.valid ? `revalidated retained quality from ${record.source.report} (${record.source.sitting})` : `retained quality unavailable: ${record.errors.join('; ')}`);
process.exitCode = record.valid ? 0 : 1;
