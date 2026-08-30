// The whole release benchmark gate as one command: node benchmark/release.mjs [--store <name>]
// Runs every measurement RELEASING.md reads, in order, and exits nonzero if any step does.
// Steps that fetch (corpora, npm baselines, the fever wiki dump) cache through
// benchmark/lib/cache.mjs, so only the first run on a machine pays the downloads.
//
// No flag: the default store's gate (compare vs last release, scale, stress, both quality
// evals). A named store has no npm baseline that can run it (the last release predates
// store) and the quality evals are store-independent (one sitting under the default store
// stands for every store), so its gate is the tree battery alone: hub + scale + stress.
//
// Steps run cheapest first, so the shape of the whole path is proven on the smallest corpus
// before an hour goes into the big ones. Each carries a timeout sized as a hang detector, not
// a performance gate: generous enough that a slow machine never trips it, so a step that hits
// it has stopped making progress rather than merely taken a while.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const argv = process.argv.slice(2);
const storeIdx = argv.indexOf('--store');
const store = storeIdx >= 0 ? argv[storeIdx + 1] : null;
const storeArgs = store ? ['--store', store] : [];

const MINUTES = 60_000;
// [title, args, timeoutMs]
const STEPS = store
  ? [
      ['hub battery', ['benchmark/run.mjs', '.', 'obsidian-hub', ...storeArgs], 20 * MINUTES],
      ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1', ...storeArgs], 30 * MINUTES],
      ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1', ...storeArgs], 45 * MINUTES],
      ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1', ...storeArgs], 30 * MINUTES],
    ]
  : [
      ['compare: last release vs working tree', ['benchmark/compare.mjs'], 30 * MINUTES],
      ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1'], 30 * MINUTES],
      ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1'], 45 * MINUTES],
      ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1'], 30 * MINUTES],
      ['quality: nfcorpus', ['benchmark/eval.mjs', 'nfcorpus'], 20 * MINUTES],
      ['quality: fever', ['benchmark/eval.mjs', 'fever'], 45 * MINUTES],
    ];

let failed = 0;
for (const [title, args, timeout] of STEPS) {
  console.log(`\n===== ${title}${store ? ` (${store})` : ''} =====`);
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', timeout, killSignal: 'SIGKILL' });
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  // A timed-out child is killed, so report the hang rather than the signal it died from: the
  // remaining steps still run, because one dead measurement should not discard the others.
  if (r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGKILL' && Date.now() - started >= timeout)) {
    failed++;
    console.error(`TIMED OUT after ${elapsed} (limit ${timeout / MINUTES}m), killed: ${args.join(' ')}`);
  } else if (r.status !== 0) {
    failed++;
    console.error(`FAILED (exit ${r.status}) after ${elapsed}: ${args.join(' ')}`);
  } else {
    console.log(`-- ${title}: ok in ${elapsed}`);
  }
}
if (failed > 0) {
  console.error(`\n${failed} step(s) failed`);
  process.exit(1);
}
console.log('\nall benchmark steps passed; paste the tables into BENCHMARKING.md from this output');
