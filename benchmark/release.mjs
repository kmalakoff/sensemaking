// Release benchmark gate: node benchmark/release.mjs [--store <name>]. Runs every measurement
// RELEASING.md reads and exits nonzero if any step does; fetches cache via benchmark/lib/cache.mjs.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const argv = process.argv.slice(2);
const storeIdx = argv.indexOf('--store');
const store = storeIdx >= 0 ? argv[storeIdx + 1] : null;
const _storeArgs = store ? ['--store', store] : [];

const MINUTES = 60_000;

// Every store schema.json offers, read from the schema rather than listed here: a store a tree can
// name is a store this gate runs, and the two cannot drift apart. sqlite is the default the
// baseline-bearing steps use, so the others are gated on the tree battery below.
const OFFERED = JSON.parse(readFileSync(join(ROOT, 'schema.json'), 'utf8')).properties.store.enum;
const DEFAULT_STORE = 'sqlite';

// The tree battery, per store: the corpora at the sizes a real tree reaches. A store that only
// ever ran against fixture trees can be quadratic and look fine, which is how turso shipped in
// 0.19.0 unable to index the 6.5k hub corpus.
const treeBattery = (name) => {
  const args = name ? ['--store', name] : [];
  return [
    ['hub battery', ['benchmark/run.mjs', '.', 'obsidian-hub', ...args], 20 * MINUTES],
    ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1', ...args], 30 * MINUTES],
    ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1', ...args], 45 * MINUTES],
    ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1', ...args], 30 * MINUTES],
  ].map(([title, a, t]) => [name ? `${title} (${name})` : title, a, t]);
};

// A named store runs its own battery alone. Otherwise: the default store's full gate, which owns
// the npm baseline and the quality evals, then every other offered store's tree battery.
const STEPS = store
  ? treeBattery(store)
  : [
      ['compare: last release vs working tree', ['benchmark/compare.mjs'], 30 * MINUTES],
      ['scale: 13k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x2-x2-hub-1'], 30 * MINUTES],
      ['scale: 26k', ['benchmark/run.mjs', '.', '.tmp/cache/obsidian-hub-x4-x4-hub-1'], 45 * MINUTES],
      ['stress: shape-cliff guard', ['benchmark/run.mjs', '.', '.tmp/cache/stress-stress-1'], 30 * MINUTES],
      ['quality: nfcorpus', ['benchmark/eval.mjs', 'nfcorpus'], 20 * MINUTES],
      ['quality: fever', ['benchmark/eval.mjs', 'fever'], 45 * MINUTES],
      ...OFFERED.filter((name) => name !== DEFAULT_STORE).flatMap(treeBattery),
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
