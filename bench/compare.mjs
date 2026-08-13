// Full benchmark flow: install versions, copy the tree per version, run run.mjs for each,
// print a ready-to-paste markdown table.
// usage: node bench/compare.mjs <notes-dir> <version...>   e.g. node bench/compare.mjs ~/notes 0.2.1 local
// 'local' = this repo's working tree; anything else = that version from npm.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [treeDir, ...versions] = process.argv.slice(2);
if (!treeDir || versions.length === 0) {
  console.error('usage: node bench/compare.mjs <notes-dir> <version...>   (version = npm semver or "local")');
  process.exit(2);
}

const benchDir = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'sense-bench-'));

function rootFor(version) {
  if (version === 'local') return join(benchDir, '..');
  const prefix = join(work, `pkg-${version}`);
  writeFileSync(join(work, 'package.json'), '{"name":"bench","private":true}'); // stop npm walking up
  const install = spawnSync('npm', ['install', `sensemaking@${version}`, '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix], { cwd: work, encoding: 'utf8' });
  if (install.status !== 0) {
    console.error(`npm install sensemaking@${version} failed:\n${install.stderr}`);
    process.exit(1);
  }
  return join(prefix, 'node_modules', 'sensemaking');
}

// Fresh copy per version: cache formats and config auto-migration must not cross versions.
// The copy gets a v1 config (the lowest common denominator every version can read).
function treeCopyFor(version) {
  const copy = join(work, `tree-${version}`);
  cpSync(treeDir, copy, { recursive: true, filter: (src) => !/\/(\.sense|\.git|node_modules)(\/|$)/.test(src) });
  writeFileSync(join(copy, 'sense.config.json'), '{"version":1,"scan":{"include":["**/*.md"]},"queries":{}}');
  return copy;
}

const results = new Map();
for (const version of versions) {
  process.stderr.write(`benchmarking ${version}...\n`);
  const out = spawnSync(process.execPath, [join(benchDir, 'run.mjs'), rootFor(version), treeCopyFor(version)], { encoding: 'utf8', maxBuffer: 16e6 });
  if (out.status !== 0) {
    console.error(`run.mjs failed for ${version}:\n${out.stderr}`);
    process.exit(1);
  }
  results.set(version, JSON.parse(out.stdout));
}

const first = results.values().next().value;
const ms = (v) => (v === null ? '—' : typeof v === 'string' ? `**${v}**` : `${v} ms`);
const ROWS = [
  ['cold crawl', (r) => ms(r.cold_crawl_ms)],
  ['warm query (`COUNT(*)`)', (r) => ms(r.warm_query_ms)],
  ['BM25 search (canonical join)', (r) => ms(r.bm25_search_ms)],
  ['`find` (BM25 + link fusion)', (r) => ms(r.find_ms)],
  ['`map` (orient)', (r) => (r.map_ms === null ? '—' : `${r.map_ms} ms / ~${r.map_tokens} tokens`)],
  [`\`peek\` largest note (~${first.largest_note_tokens} t)`, (r) => (r.peek_ms === null ? '—' : `${r.peek_ms} ms / ~${r.peek_tokens} tokens (${((r.peek_tokens / r.largest_note_tokens) * 100).toFixed(1)}%)`)],
  ['in-process: cold index build', (r) => (r.inproc?.cold_build_ms === undefined ? `**${r.inproc?.error ?? '—'}**` : `${r.inproc.cold_build_ms} ms`)],
  ['in-process: freshness check, no change', (r) => (r.inproc?.open_nochange_ms === undefined ? '—' : `${r.inproc.open_nochange_ms} ms`)],
  ['in-process: update, 1 file touched', (r) => (r.inproc?.update_1_file_ms === undefined ? '—' : `${r.inproc.update_1_file_ms} ms`)],
  ['in-process: update, 10 files modified', (r) => (r.inproc?.update_10_files_ms === undefined ? '—' : `${r.inproc.update_10_files_ms} ms`)],
];

console.log(`| metric | ${versions.join(' | ')} |`);
console.log(`|---|${versions.map(() => '---').join('|')}|`);
for (const [label, cell] of ROWS) {
  console.log(`| ${label} | ${versions.map((v) => cell(results.get(v))).join(' | ')} |`);
}

rmSync(work, { recursive: true, force: true });
