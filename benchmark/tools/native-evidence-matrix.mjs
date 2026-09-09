#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
// Runs the bounded native diagnostic matrix. Every command writes its own JSON artifact before
// the next command starts, so an interrupted sitting retains the completed comparisons.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NATIVE_CAPABILITY_CASES, NATIVE_CAPABILITY_VECTOR_DIMS } from '../lib/native-capability.mjs';
import { NATIVE_UPDATE_COUNTS, nativeComparisonSucceeded, nativeEvidenceExecutionPlan } from '../lib/native-update-contract.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_BASELINE_NOTES = 6;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_OUT_DIR = join(ROOT, '.tmp', `native-evidence-matrix-${Date.now()}`);
const STORES = ['sqlite', 'duckdb', 'turso'];

function usage() {
  console.error('usage: node benchmark/tools/native-evidence-matrix.mjs [--out-dir DIR] [--baseline-notes N]');
  console.error(`runs ${NATIVE_CAPABILITY_CASES.length} native cases, baseline at a second note count, and updates at ${NATIVE_UPDATE_COUNTS.join('/')}`);
}

let values;
try {
  ({ values } = parseArgs({ options: { 'out-dir': { type: 'string' }, 'baseline-notes': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true, allowPositionals: false }));
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (values.help) {
  usage();
  process.exit(0);
}

const baselineNotes = Number(values['baseline-notes'] ?? DEFAULT_BASELINE_NOTES);
if (!Number.isSafeInteger(baselineNotes) || baselineNotes <= 4 || baselineNotes > 50_000) {
  console.error('--baseline-notes must be an integer from 5 to 50000');
  process.exit(2);
}

const outDir = resolve(values['out-dir'] ?? DEFAULT_OUT_DIR);
if (existsSync(outDir)) {
  const stat = lstatSync(outDir);
  if (!stat.isDirectory() || readdirSync(outDir).length > 0) {
    console.error(`matrix output must be a new empty directory: ${outDir}`);
    process.exit(2);
  }
} else mkdirSync(outDir, { recursive: true });
const capabilityDir = join(outDir, 'native-capability');
const updateDir = join(outDir, 'native-update');
mkdirSync(capabilityDir, { recursive: true });
mkdirSync(updateDir, { recursive: true });
const summaryPath = join(outDir, 'matrix.json');
const started = new Date().toISOString();
const writeSummary = (summary) => {
  const temporary = `${summaryPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`);
  renameSync(temporary, summaryPath);
};
const running = { schema: 'native-evidence-matrix-v1', status: 'running', valid: false, started, out_dir: outDir };
writeSummary(running);
process.on('uncaughtException', (error) => {
  writeSummary({ ...running, status: 'failed', valid: false, finished: new Date().toISOString(), errors: [error instanceof Error ? error.message : String(error)] });
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  writeSummary({ ...running, status: 'failed', valid: false, finished: new Date().toISOString(), errors: [error instanceof Error ? error.message : String(error)] });
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});

function run(label, script, args, output) {
  const child = spawnSync(process.execPath, [join(ROOT, script), ...args, '--out', output], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.error) throw new Error(`${label}: ${child.error.message}`);
  if (child.signal) throw new Error(`${label}: terminated by ${child.signal}`);
  if (child.status !== 0) throw new Error(`${label}: exited ${child.status}${child.stderr ? `: ${child.stderr.trim()}` : ''}`);
  if (child.stderr) process.stderr.write(child.stderr);
}

function successfulComparison(path, label, kind) {
  const comparison = JSON.parse(readFileSync(path, 'utf8'));
  if (!nativeComparisonSucceeded(kind, comparison)) throw new Error(`${label}: comparison did not record explicit success`);
}

const records = [];
function capability(group) {
  const { case_id: caseId, notes } = group;
  const artifacts = [];
  for (const [index, store] of group.stores.entries()) {
    const artifact = join(capabilityDir, group.artifact_files[index]);
    run(`native capability ${caseId}/${store}`, 'benchmark/tools/native-capability.mjs', ['--store', store, '--case', caseId, '--notes', String(notes)], artifact);
    artifacts.push(artifact);
  }
  const comparison = join(capabilityDir, group.comparison_file);
  run(`native capability comparison ${caseId}`, 'benchmark/tools/native-capability-compare.mjs', artifacts, comparison);
  successfulComparison(comparison, `native capability comparison ${caseId}`, 'native-capability');
  records.push({ kind: 'native-capability', case_id: caseId, notes, artifacts, comparison });
}

for (const group of nativeEvidenceExecutionPlan(baselineNotes).comparators) {
  if (group.kind === 'native-capability') capability(group);
  else {
    const artifacts = group.stores.map((store, index) => {
      const artifact = join(updateDir, group.artifact_files[index]);
      run(`native update ${group.changed}/${store}`, 'benchmark/tools/native-update.mjs', ['--store', store, '--changed', String(group.changed)], artifact);
      return artifact;
    });
    const comparison = join(updateDir, group.comparison_file);
    run(`native update comparison ${group.changed}`, 'benchmark/tools/native-update-compare.mjs', artifacts, comparison);
    successfulComparison(comparison, `native update comparison ${group.changed}`, 'native-update');
    records.push({ kind: 'native-update', changed: group.changed, notes: 260, artifacts, comparison });
  }
}

const hash = (path) => ({ path, bytes: lstatSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
const artifactManifest = records.flatMap((record) => [...record.artifacts, ...(record.comparison ? [record.comparison] : [])].map(hash));

const summary = {
  schema: 'native-evidence-matrix-v1',
  status: 'success',
  valid: true,
  stores: STORES,
  native_schema_dims: NATIVE_CAPABILITY_VECTOR_DIMS,
  baseline_notes: 4,
  second_baseline_notes: baselineNotes,
  update_counts: NATIVE_UPDATE_COUNTS,
  records,
  artifact_manifest: artifactManifest,
  finished: new Date().toISOString(),
};
writeSummary(summary);
console.log(JSON.stringify({ ...summary, out_dir: outDir, summary: summaryPath }, null, 2));
