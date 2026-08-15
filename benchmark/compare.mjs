// Full benchmark flow: install versions, copy the tree per version, run run.mjs for each,
// print a ready-to-paste markdown table.
// usage: node benchmark/compare.mjs [corpus-or-dir] [version...]
// Defaults: obsidian-hub corpus, the released baseline vs 'local' (this working tree) -- so a
// bare `node benchmark/compare.mjs` answers "did the working tree regress?". The baseline is
// package.json's own version: the bump happens after a release, so during development it names
// the last release, and no version is written down anywhere in the harness. Named corpora and
// npm installs cache under .tmp/ (published versions are immutable; delete .tmp to refetch).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached } from './lib/cache.mjs';
import { corpusPath } from './lib/corpus.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(benchDir, '..');

function releasedBaseline() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version) {
    console.error('package.json has no version; pass versions explicitly');
    process.exit(1);
  }
  return pkg.version;
}

const [corpusArg, ...versionArgs] = process.argv.slice(2);
const treeDir = corpusArg ? (corpusPath(corpusArg) ?? resolve(corpusArg)) : corpusPath('obsidian-hub');
if (!existsSync(treeDir)) {
  console.error(`not a corpus name or directory: ${corpusArg}`);
  process.exit(2);
}
const versions = versionArgs.length > 0 ? versionArgs : [releasedBaseline(), 'local'];

const work = mkdtempSync(join(tmpdir(), 'sense-bench-'));

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
  ['`find` row size (json)', (r) => (r.find_row_tokens == null ? '—' : `~${r.find_row_tokens} tokens`)],
  ['`map` (orient)', (r) => (r.map_ms === null ? '—' : `${r.map_ms} ms / ~${r.map_tokens} tokens`)],
  [`\`peek\` largest note (~${first.largest_note_tokens} t)`, (r) => (r.peek_ms === null ? '—' : `${r.peek_ms} ms / ~${r.peek_tokens} tokens (${((r.peek_tokens / r.largest_note_tokens) * 100).toFixed(1)}%)`)],
  [`bulk change (${first.bulk_files} files): first query`, (r) => ms(r.bulk_change_ms)],
  [`bulk change (${first.bulk_files} files): with warm watcher`, (r) => ms(r.bulk_watch_ms)],
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
