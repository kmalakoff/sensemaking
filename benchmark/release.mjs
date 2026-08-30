// The whole release benchmark gate as one command: node benchmark/release.mjs [--store <name>]
// Runs every measurement RELEASING.md reads, in order, and exits nonzero if any step does.
// Steps that fetch (corpora, npm baselines, the fever wiki dump) cache through
// benchmark/lib/cache.mjs, so only the first run on a machine pays the downloads.
//
// No flag: the default store's gate (compare vs last release, scale, stress, both quality
// evals). A named store has no npm baseline that can run it (the last release predates
// store) and the quality evals are store-independent (one sitting under the default store
// stands for every store), so its gate is the tree battery alone: hub + scale + stress.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const argv = process.argv.slice(2);
const storeIdx = argv.indexOf('--store');
const store = storeIdx >= 0 ? argv[storeIdx + 1] : null;
const storeArgs = store ? ['--store', store] : [];

const STEPS = store
  ? [
      ['hub battery', ['benchmark/run.mjs', '.', 'obsidian-hub', ...storeArgs]],
      ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1', ...storeArgs]],
      ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1', ...storeArgs]],
      ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1', ...storeArgs]],
    ]
  : [
      ['compare: last release vs working tree', ['benchmark/compare.mjs']],
      ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1']],
      ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1']],
      ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1']],
      ['quality: nfcorpus', ['benchmark/eval.mjs', 'nfcorpus']],
      ['quality: fever', ['benchmark/eval.mjs', 'fever']],
    ];

let failed = 0;
for (const [title, args] of STEPS) {
  console.log(`\n===== ${title}${store ? ` (${store})` : ''} =====`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED (exit ${r.status}): ${args.join(' ')}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} step(s) failed`);
  process.exit(1);
}
console.log('\nall benchmark steps passed; paste the tables into BENCHMARKING.md from this output');
