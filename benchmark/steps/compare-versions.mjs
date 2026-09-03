// Runs run.mjs per version against its own copy of the tree, prints a pasteable table. Baseline is package.json's version, so a bare run answers "did the working tree regress?".
// usage: node benchmark/steps/compare-versions.mjs [corpus-or-dir] [version...] [--store <name>] [--reverse] [--out <file>]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { cached } from '../lib/cache.mjs';
import { corpusPath, writeTreeConfig } from '../lib/corpus.mjs';
import { writeOut } from '../lib/out.mjs';
import { renderRowsTable } from '../lib/render.mjs';
import { ROWS, TIMING_KINDS } from '../lib/rows.mjs';
import { copyTree } from '../lib/work-tree.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(benchDir, '..', '..');

function releasedBaseline() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version) {
    console.error('package.json has no version; pass versions explicitly');
    process.exit(1);
  }
  return pkg.version;
}

const {
  values: { store, out: outArg, reverse },
  positionals: [corpusArg, ...versionArgs],
} = parseArgs({
  options: { store: { type: 'string' }, out: { type: 'string' }, reverse: { type: 'boolean', default: false } },
  allowPositionals: true,
});
const treeDir = corpusArg ? (corpusPath(corpusArg) ?? resolve(corpusArg)) : corpusPath('obsidian-hub');
if (!existsSync(treeDir)) {
  console.error(`not a corpus name or directory: ${corpusArg}`);
  process.exit(2);
}
const versions = versionArgs.length > 0 ? versionArgs : [releasedBaseline(), 'local'];
// The remedy for a suspicious delta (2026-08-21 methodology, PLAN.md 3.10): the same measurement
// with run order and column order both swapped, so a measurement-order artifact shows up as the
// delta flipping rather than repeating.
if (reverse) versions.reverse();

mkdirSync(join(benchDir, '..', '..', '.tmp'), { recursive: true });
const work = mkdtempSync(join(benchDir, '..', '..', '.tmp', 'bench-'));

function rootFor(version) {
  if (version === 'local') return ROOT;
  const dir = cached(`sensemaking-${version}`, (staging) => {
    writeFileSync(join(staging, 'package.json'), '{"name":"bench","private":true}'); // stop npm walking up
    const install = spawnSync('npm', ['install', `sensemaking@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', staging], { cwd: staging, encoding: 'utf8' });
    if (install.status !== 0) throw new Error(`npm install sensemaking@${version} failed:\n${install.stderr}`);
  });
  return join(dir, 'node_modules', 'sensemaking');
}

// Fresh copy per version: cache formats and config auto-migration must not cross versions.
// The copy gets a v1 config (the lowest common denominator every version can read).
function treeCopyFor(version) {
  const copy = join(work, `tree-${version}`);
  copyTree(treeDir, copy);
  // No store key here: run.mjs rewrites the config for every new-dialect column (adding the
  // store when one is named), and old-dialect columns read the v1 shape as-is.
  writeTreeConfig(copy, { version: 1, scan: { include: ['**/*.md'] }, queries: {} });
  return copy;
}

const results = new Map();
for (const version of versions) {
  process.stderr.write(`benchmarking ${version}...\n`);
  const out = spawnSync(process.execPath, [join(benchDir, 'measure-tree.mjs'), rootFor(version), treeCopyFor(version), ...(store ? ['--store', store] : [])], { encoding: 'utf8', maxBuffer: 16e6 });
  if (out.status !== 0) {
    writeOut(outArg, { corpus: treeDir, store: store ?? 'sqlite', versions, reversed: reverse, error: `run.mjs failed for ${version}: ${out.stderr}` });
    console.error(`run.mjs failed for ${version}:\n${out.stderr}`);
    process.exit(1);
  }
  results.set(version, JSON.parse(out.stdout));
}

// The embed column must never compare a real number against a silent gap: a version whose
// dialect supports it but produced no cold_embed_ms is a broken measurement, not an absent one,
// and gets a hard failure instead of a half table.
const embedCapable = versions.filter((v) => results.get(v).embed_supported);
const embedBroken = embedCapable.filter((v) => results.get(v).cold_embed_ms === null);
if (embedBroken.length > 0) {
  writeOut(outArg, { corpus: treeDir, store: store ?? 'sqlite', versions, reversed: reverse, error: `embed column broken for ${embedBroken.join(', ')}`, results: Object.fromEntries(results) });
  console.error(`embed column broken for ${embedBroken.join(', ')}: ${embedBroken.map((v) => `${v}: ${results.get(v).cold_embed_error ?? 'no error captured'}`).join('; ')}`);
  process.exit(1);
}
if (embedCapable.length === 0) {
  console.error('embed column: no version being compared supports the embed mechanism it measures -- the vectors column measures nothing for this run');
} else if (embedCapable.length < versions.length) {
  console.error(`embed column note: ${versions.filter((v) => !results.get(v).embed_supported).join(', ')} predate the embed mechanism this column measures; only ${embedCapable.join(', ')} are comparable on it`);
}

// Every wall/inproc/tokens catalog row prints as one table row here; report.mjs renders the
// same rows from the --out JSON below through the same renderer, so the two never drift.
const printable = ROWS.filter((row) => TIMING_KINDS.includes(row.kind));
const resultsByColumn = Object.fromEntries(versions.map((v) => [v, results.get(v)]));
console.log(renderRowsTable(printable, versions, resultsByColumn));

writeOut(outArg, { corpus: treeDir, store: store ?? 'sqlite', versions, reversed: reverse, results: Object.fromEntries(results) });

safeRmSync(work, { recursive: true, force: true });
