// Shape sweep: synthetic corpora isolating one dimension at a time, the rest held hub-like.
// Every point runs against a working copy, strictly serially -- a shared CPU swamps the signal.
// usage: node benchmark/sweep.mjs [dimension ...] [--quick] [--out file]
// dimensions: fields headings links filesize notes bulk probes presets (default: all)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { syntheticPath } from './lib/corpus.mjs';
import { futureDate, median, timedCli, walkMd } from './lib/measure.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'cli.js');
const WORK_ROOT = join(ROOT, '.tmp', 'sweep-work');

const DIMENSION_NAMES = ['fields', 'headings', 'links', 'filesize', 'notes', 'bulk', 'probes', 'presets'];

const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
let OUT = join(ROOT, '.tmp', 'sweep-results.jsonl');
const requested = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--quick') continue;
  if (argv[i] === '--out') {
    OUT = resolve(argv[++i]);
    continue;
  }
  requested.push(argv[i]);
}
for (const d of requested) {
  if (!DIMENSION_NAMES.includes(d)) {
    console.error(`unknown dimension: ${d} (choices: ${DIMENSION_NAMES.join(', ')})`);
    process.exit(2);
  }
}
const dimensions = requested.length ? requested : DIMENSION_NAMES;

// Hub-like values every dimension holds the non-swept params at.
const HUB = { notes: 6000, noteTokens: 500, headingsPerNote: 8, linksPerNote: 5, distinctFields: 30, fieldsPerNote: 8, seed: 1 };

const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

mkdirSync(WORK_ROOT, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

function record(dimension, params, metrics) {
  const row = { dimension, params, metrics, date: new Date().toISOString(), node: process.version };
  appendFileSync(OUT, `${JSON.stringify(row)}\n`);
  return row;
}

// Cached corpus stays pristine: every measurement runs against a throwaway copy.
function workingCopy(tree) {
  const dir = join(WORK_ROOT, randomBytes(6).toString('hex'));
  cpSync(tree, dir, { recursive: true });
  rmSync(join(dir, '.sense'), { recursive: true, force: true });
  return dir;
}

const runCli = (cwd, args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', maxBuffer: 64e6 });

const timed = (cwd, args, runs = 3) => timedCli(() => runCli(cwd, args), runs);

// Three in-process measurements plus three wall CLI ones. peek and the touch target the
// largest note: on the filesize dimension that note is the whole point.
async function measurePoint(spec) {
  const src = syntheticPath(spec);
  const work = workingCopy(src);
  try {
    const mdFiles = walkMd(work);
    const target = mdFiles.reduce((a, b) => (statSync(join(work, b)).size > statSync(join(work, a)).size ? b : a));
    const cfg = lib.loadConfig(join(work, 'sense.config.json'));

    const openClose = () => {
      const t = process.hrtime.bigint();
      const { db } = lib.open(cfg);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      db.close();
      return ms;
    };

    const t0 = process.hrtime.bigint();
    openClose();
    const cold_build_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const open_nochange_ms = median(openClose, 5);
    const update_1_file_ms = median(() => {
      utimesSync(join(work, target), futureDate(), futureDate());
      return openClose();
    }, 3);

    const mapR = timed(work, ['map']);
    const peekR = timed(work, ['peek', target]);
    // find_ms: lexical ranked search, no vectors -- --lexical is search's opt-out (default participates).
    const findR = timed(work, ['search', 'the', '--lexical', '--k', '10']);

    return {
      cold_build_ms,
      open_nochange_ms,
      update_1_file_ms,
      map_ms: mapR.ms,
      map_tokens: Math.round(mapR.bytes / 4),
      peek_ms: peekR.ms,
      peek_tokens: Math.round(peekR.bytes / 4),
      find_ms: findR.ms,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function printTable(title, paramName, points) {
  const metricNames = Object.keys(points[0].metrics);
  console.log(`\n### ${title}\n`);
  console.log(`| ${paramName} | ${metricNames.join(' | ')} |`);
  console.log(`|---|${metricNames.map(() => '---').join('|')}|`);
  for (const p of points) console.log(`| ${p.param} | ${metricNames.map((m) => p.metrics[m]).join(' | ')} |`);
  printVerdict(points, metricNames);
}

// Flags a metric whose cost ratio outpaces the swept param's ratio by 1.5x (superlinear),
// or a *_tokens metric that grows at all -- map/peek/find token output is a contract meant
// to stay flat with tree size, so any growth there is worth a look even if sub-1.5x.
function printVerdict(points, metricNames) {
  console.log('\nscaling verdict:');
  let flagged = false;
  for (let i = 1; i < points.length; i++) {
    const paramRatio = points[i].param / points[i - 1].param;
    for (const m of metricNames) {
      const a = points[i - 1].metrics[m];
      const b = points[i].metrics[m];
      if (typeof a !== 'number' || typeof b !== 'number' || a <= 0) continue;
      const costRatio = b / a;
      const tokenMetric = m.endsWith('tokens');
      if (costRatio > 1.5 * paramRatio) {
        console.log(`  SUPERLINEAR ${m}: param ${points[i - 1].param}->${points[i].param} (${paramRatio.toFixed(2)}x), cost ${a}->${b} (${costRatio.toFixed(2)}x)`);
        flagged = true;
      } else if (tokenMetric && costRatio > 1.001) {
        console.log(`  TOKEN GROWTH ${m}: ${a}->${b} (${costRatio.toFixed(2)}x) at param ${points[i - 1].param}->${points[i].param} -- output contract expected flat`);
        flagged = true;
      }
    }
  }
  if (!flagged) console.log('  none: every metric scaled linear-or-flat across these points');
}

async function sweepOne(dimension, paramName, values, specFor) {
  const points = [];
  for (const v of values) {
    console.error(`${dimension}: ${paramName}=${v}`);
    const spec = specFor(v);
    const metrics = await measurePoint(spec);
    record(dimension, { ...spec, [paramName]: v }, metrics);
    points.push({ param: v, metrics });
  }
  printTable(dimension, paramName, points);
  return points;
}

// distinctFields near SQLITE_MAX_COLUMN (2000): fieldsPerNote == distinctFields so every
// note declares the whole pool, guaranteeing the frontmatter table actually reaches that
// many columns rather than a random subsample falling short of the pool size.
async function columnLimitProbe(dimension) {
  console.log(`\n### ${dimension}: column-limit probe (distinctFields near SQLITE_MAX_COLUMN=2000, notes=100)`);
  const rows = [];
  for (const distinctFields of [1900, 2000, 2100]) {
    const spec = { notes: 100, noteTokens: 200, headingsPerNote: 4, linksPerNote: 3, distinctFields, fieldsPerNote: distinctFields, seed: 7 };
    const src = syntheticPath(spec);
    const work = workingCopy(src);
    let result;
    try {
      const r = runCli(work, ['status']);
      result = { status: r.status, stdout: (r.stdout ?? '').trim().slice(0, 500), stderr: (r.stderr ?? '').trim().slice(0, 500) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    record(dimension, { distinctFields, notes: 100 }, result);
    rows.push({ distinctFields, ...result });
  }
  console.log('\n| distinctFields | exit | message |');
  console.log('|---|---|---|');
  for (const r of rows) {
    const message = (r.stderr || r.stdout || '(empty)').split('\n')[0].replace(/\|/g, '\\|');
    console.log(`| ${r.distinctFields} | ${r.status} | ${message} |`);
  }
}

// remove-markdown is regex-based; pathological nesting/bracket-run inputs risk catastrophic
// backtracking, so the crawl runs under a hard wall-clock timeout instead of trusting it to return.
async function adversarialProbe() {
  console.log('\n### probes: remove-markdown adversarial crawl (15s hard timeout)');
  const spec = { notes: 5, noteTokens: 50, headingsPerNote: 2, linksPerNote: 1, distinctFields: 5, fieldsPerNote: 2, seed: 11, adversarial: true };
  const src = syntheticPath(spec);
  const work = workingCopy(src);
  let result;
  try {
    const t0 = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI, 'status'], { cwd: work, encoding: 'utf8', maxBuffer: 64e6, timeout: 15_000 });
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const timedOut = r.signal !== null || (r.error && r.error.code === 'ETIMEDOUT');
    result = timedOut ? { ms, status: 'TIMEOUT', signal: r.signal } : { ms, status: r.status, stderr: (r.stderr ?? '').trim().slice(0, 500) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  record('probes', { adversarial: true, notes: spec.notes }, result);
  console.log(`  crawl: ${JSON.stringify(result)}`);
}

// Vectors build lazily on the first semantic-participating query (embedPending tops up NULL
// rows), not at reconcile -- so the warm-up call pays the embed cost and subsequent calls
// don't. Model is assumed already cached in ~/.cache/sensemaking; this probe doesn't fetch it.
async function semanticProbe() {
  console.log('\n### probes: semantic (bare `search` warm-up + 3 timed, median)');
  const rows = [];
  for (const notes of [6000, 26000]) {
    const spec = { ...HUB, notes, embed: true };
    const src = syntheticPath(spec);
    const work = workingCopy(src);
    try {
      let t = process.hrtime.bigint();
      const warm = runCli(work, ['search', 'the', '--k', '10']);
      const warmup_ms = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
      const semantic_find_ms = Math.round(
        median(() => {
          t = process.hrtime.bigint();
          runCli(work, ['search', 'the', '--k', '10']);
          return Number(process.hrtime.bigint() - t) / 1e6;
        }, 3)
      );
      const result = { warmup_status: warm.status, warmup_ms, semantic_find_ms };
      record('probes', { semantic: true, notes }, result);
      rows.push({ notes, ...result });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  console.log('\n| notes | warmup_ms | semantic_find_ms (median of 3) |');
  console.log('|---|---|---|');
  for (const r of rows) console.log(`| ${r.notes} | ${r.warmup_ms} | ${r.semantic_find_ms} |`);
}

// Mixed-preset tree: files only a semantic-false preset covers must end up with zero
// embeddings rows, checked after a warm-up search triggers the lazy embedding.
async function presetsProbe() {
  console.log('\n### presets: mixed semantic coverage (default = a/** semantic on, raw = b/** semantic off)\n');
  const spec = {
    ...HUB,
    notes: 2000,
    presets: [
      { name: 'default', dir: 'a', semantic: true },
      { name: 'raw', dir: 'b', semantic: false },
    ],
  };
  const src = syntheticPath(spec);
  const work = workingCopy(src);
  try {
    const t = process.hrtime.bigint();
    const cold = runCli(work, ['status']);
    const cold_crawl_ms = Math.round(Number(process.hrtime.bigint() - t) / 1e6);

    runCli(work, ['search', 'the', '--k', '10']); // warm-up: triggers embedding for the default preset's coverage

    const statusOut = runCli(work, ['status', '--format', 'json']);
    const status = JSON.parse(statusOut.stdout);
    const coverage = Object.fromEntries(status.presets.map((p) => [p.name, p]));
    const pass = coverage.raw?.embedded === 0 && coverage.raw?.files > 0 && coverage.default?.embedded === coverage.default?.files && coverage.default?.files > 0;
    record('presets', { notes: spec.notes }, { cold_crawl_ms, coverage, pass });
    console.log(`  cold crawl: ${cold_crawl_ms} ms (status exit ${cold.status})`);
    console.log(`  embedding derivation: ${pass ? 'PASS' : 'FAIL'} -- default files=${coverage.default?.files} embedded=${coverage.default?.embedded}; raw files=${coverage.raw?.files} embedded=${coverage.raw?.embedded} (must be 0)`);

    const defaultR = timed(work, ['search', 'the', '--k', '10']);
    const rawR = timed(work, ['search', 'the', '--preset', 'raw', '--k', '10']);
    const includeR = timed(work, ['search', 'the', '--include', 'a/**/*.md', '--k', '10']);
    record('presets', { notes: spec.notes }, { search_default_ms: defaultR.ms, search_raw_ms: rawR.ms, search_include_ms: includeR.ms });
    console.log('\n| operation | ms |');
    console.log('|---|---|');
    console.log(`| \`search\` (default preset, semantic on) | ${defaultR.ms} |`);
    console.log(`| \`search --preset raw\` (semantic off) | ${rawR.ms} |`);
    console.log(`| \`search --include a/**/*.md\` (ad hoc scope override) | ${includeR.ms} |`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

for (const dimension of dimensions) {
  if (dimension === 'fields') {
    await sweepOne('fields', 'distinctFields', [30, 300, 1000], (distinctFields) => ({ ...HUB, distinctFields }));
    await columnLimitProbe('fields');
  } else if (dimension === 'headings') {
    await sweepOne('headings', 'headingsPerNote', [10, 200, 2000], (headingsPerNote) => ({ ...HUB, notes: 500, headingsPerNote }));
  } else if (dimension === 'links') {
    await sweepOne('links', 'linksPerNote', [5, 100, 1000], (linksPerNote) => ({ ...HUB, notes: 2000, linksPerNote }));
  } else if (dimension === 'filesize') {
    await sweepOne('filesize', 'bigNoteBytes', [100_000, 1_000_000, 10_000_000], (bigNoteBytes) => ({ ...HUB, notes: 20, bigNoteBytes }));
  } else if (dimension === 'notes') {
    const values = QUICK ? [6000, 26000] : [6000, 26000, 50000, 100000];
    await sweepOne('notes', 'notes', values, (notes) => ({ ...HUB, notes }));
  } else if (dimension === 'bulk') {
    console.log('\n### bulk (notes=26000, touch N files, time the next open)\n');
    const spec = { ...HUB, notes: 26000 };
    const src = syntheticPath(spec);
    const points = [];
    for (const touchFiles of [50, 500, 5000]) {
      console.error(`bulk: touch=${touchFiles}`);
      const work = workingCopy(src);
      let bulk_open_ms;
      try {
        const mdFiles = walkMd(work);
        const { db } = lib.open(lib.loadConfig(join(work, 'sense.config.json')));
        db.close();
        const future = () => new Date(Date.now() + 120_000 + Math.random() * 60_000);
        for (const f of mdFiles.slice(0, touchFiles)) utimesSync(join(work, f), future(), future());
        const t = process.hrtime.bigint();
        const { db: db2 } = lib.open(lib.loadConfig(join(work, 'sense.config.json')));
        bulk_open_ms = Math.round(Number(process.hrtime.bigint() - t) / 1e6);
        db2.close();
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
      record('bulk', { notes: spec.notes, touchFiles }, { bulk_open_ms });
      points.push({ param: touchFiles, metrics: { bulk_open_ms } });
    }
    printTable('bulk', 'touchFiles', points);
  } else if (dimension === 'probes') {
    await columnLimitProbe('probes');
    await adversarialProbe();
    if (!QUICK) await semanticProbe();
    else console.log('\n### probes: semantic skipped (--quick)');
  } else if (dimension === 'presets') {
    await presetsProbe();
  }
}
