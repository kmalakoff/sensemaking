// Release benchmark gate: node benchmark/release.mjs [--store <name>]. Runs every measurement
// RELEASING.md reads and exits nonzero if any step does; fetches cache via benchmark/lib/cache.mjs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const argv = process.argv.slice(2);
const storeIdx = argv.indexOf('--store');
const store = storeIdx >= 0 ? argv[storeIdx + 1] : null;
const storeArgs = store ? ['--store', store] : [];

const MINUTES = 60_000;
// [title, args, timeoutMs], cheapest first. A named store has no npm baseline and quality evals
// are store-independent, so its gate is the tree battery alone: hub + scale + stress.
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
  // A timed-out child is killed, so report the hang rather than the signal it died from: one
  // dead measurement should not discard the others, so the remaining steps run regardless.
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
