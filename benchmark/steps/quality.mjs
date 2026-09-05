// Retrieval quality in three passes (bm25-only, fused, semantic) plus a hidden guard pass: a vectors-free preset must be row-identical to `fused`. Paired deltas with a sign-test z.
// usage: node benchmark/steps/quality.mjs [corpus] [--queries N] [--k N] [--split test|dev] [--store name] [--out file]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from '../lib/corpus.mjs';
import { orBag, readLabels } from '../lib/labels.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import { metrics } from '../lib/metrics.mjs';
import { writeOut } from '../lib/out.mjs';
import { mdTable } from '../lib/render.mjs';
import { ROWS } from '../lib/rows.mjs';
import { stableWorkTree } from '../lib/work-tree.mjs';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const K = Number(flag('k', 10));
const MAX_QUERIES = Number(flag('queries', Infinity));
const SPLIT = flag('split', 'test');
// Retrieval quality is per-store once a store has its own lexical layer: each engine ranks with its own BM25, so scores are comparable only against the same store on the same corpus.
// sqlite only in practice: the query form is an OR bag (labels.mjs), FTS5 syntax that duckdb and
// turso refuse outright. Measured 2026-09-04, PLAN.md 3.30.
// Omitted, this measures the default store, matching every recorded baseline in benchmark/reports.
const STORE = flag('store', undefined);
const outArg = flag('out', null);

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const source = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!source || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}
// A private, reused copy of the pinned corpus: its vectors are expensive to rebuild (nfcorpus
// 3,633 docs, fever 2,860), so this stays warm across runs instead of being thrown away like
// run.mjs's per-run copy. The pinned entry in .tmp/cache is never written to.
const tree = stableWorkTree(join(ROOT, '.tmp', 'eval-work'), `${corpus}-${STORE ?? 'sqlite'}`, source);

const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const { queries, qrels } = readLabels(labelsDir, SPLIT);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);

// embed false -> vectors-free signals map (vectors never built); embed true -> config names the model and vectors build lazily on the first participating call. Without an embed block, the semantic pass silently measures lexical.
// --model/--provider/--url let a non-default corpus (e.g. an HTTP encoder over Ollama) reuse this real search()-through-chunk() path instead of bakeoff's whole-document scoring.
const EMBED = { model: flag('model', 'minishlab/potion-retrieval-32M'), provider: flag('provider', 'static'), url: flag('url', undefined) };
// There is no per-call semantic option: the preset decides. `semanticOff` writes a vectors-free `signals` weight map into the preset.
// That's the one lever the no-silent-change contract is about.
const VARIANTS = [
  { name: 'bm25-only', features: { links: false, rank: false }, embed: false, semanticOff: true },
  { name: 'fused', features: undefined, embed: false, semanticOff: true },
  { name: 'fused-embed-configured', features: undefined, embed: true, semanticOff: true, hidden: true }, // guard only
  { name: 'semantic', features: undefined, embed: true, semanticOff: false },
];

const results = [];
for (const variant of VARIANTS) {
  const cfg = {
    presets: { default: { include: ['**/*.md'], ...(variant.semanticOff ? { signals: variant.features?.links === false ? { words: 1 } : { words: 1, links: 1 } } : {}) } },
    ...(variant.embed ? { embed: EMBED } : {}),
    features: variant.features,
    queries: {},
    baseDir: tree,
    configPath: null,
    ...(STORE ? { store: STORE } : {}),
  };
  const { store } = await lib.open(cfg);
  const perQuery = new Map();
  let errors = 0;
  let ms = 0;
  for (const qid of qids) {
    const text = queries.get(qid);
    if (!text) continue;
    const t0 = process.hrtime.bigint();
    let rows = [];
    try {
      rows = await lib.search(store, cfg, orBag(text), { k: K });
    } catch {
      errors++;
    }
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const ranked = rows.map((r) => r.path.replace(/\.md$/, ''));
    perQuery.set(qid, { m: metrics(ranked, qrels.get(qid), K), rows: JSON.stringify(rows) });
  }
  await store.close();
  results.push({ ...variant, perQuery, errors, ms: ms / qids.length });
}

// Guard first: a semantic:false preset must fully disable vector participation, even on an embed-configured corpus.
// fused-embed-configured must not diverge from fused by a single row.
const fused = results.find((r) => r.name === 'fused');
const fusedEmbedConfigured = results.find((r) => r.name === 'fused-embed-configured');
const divergent = qids.filter((qid) => fused.perQuery.get(qid)?.rows !== fusedEmbedConfigured.perQuery.get(qid)?.rows);
if (divergent.length > 0) {
  writeOut(outArg, { corpus, split: SPLIT, queries: qids.length, k: K, store: STORE ?? 'sqlite', measure_version: MEASURE_VERSION, error: `NO-SILENT-CHANGE VIOLATION: ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})` });
  console.error(`NO-SILENT-CHANGE VIOLATION: semantic:false didn't fully disable vectors on the embed-configured corpus -- ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})`);
  process.exit(1);
}
console.log(`no-silent-change: ok — semantic:false on an embed-configured corpus is row-identical to fused (vectors never built) across ${qids.length} queries\n`);

const mean = (r, key) => [...r.perQuery.values()].reduce((a, q) => a + q.m[key], 0) / qids.length;
const shown = results.filter((r) => !r.hidden);
const qualityRows = ROWS.filter((row) => row.kind === 'quality');
console.log(`corpus: ${corpus} | split: ${SPLIT} | queries: ${qids.length} | k: ${K} | query form: OR bag of words\n`);
console.log(mdTable(['metric', ...shown.map((r) => r.name)], [...qualityRows.map((row) => [row.label, ...shown.map((r) => mean(r, row.key).toFixed(4))]), ['mean ms/query', ...shown.map((r) => r.ms.toFixed(1))]]));

// Paired per-query deltas between adjacent pairs of interest.
function paired(a, b, key) {
  let wins = 0;
  let losses = 0;
  for (const qid of qids) {
    const d = (b.perQuery.get(qid)?.m[key] ?? 0) - (a.perQuery.get(qid)?.m[key] ?? 0);
    if (d > 1e-12) wins++;
    else if (d < -1e-12) losses++;
  }
  const n = wins + losses;
  const z = n > 0 ? (wins - losses) / Math.sqrt(n) : 0;
  return { wins, losses, z };
}
const bm25 = results.find((r) => r.name === 'bm25-only');
const semantic = results.find((r) => r.name === 'semantic');
console.log('\npaired per-query deltas (wins/losses, sign-test z; |z| > 2 is beyond noise):');
const pairedOut = {};
for (const [label, key, a, b] of [
  ['fused vs bm25-only', 'fused_vs_bm25', bm25, fused],
  ['semantic vs fused', 'semantic_vs_fused', fused, semantic],
]) {
  const nd = paired(a, b, 'ndcg');
  const h = paired(a, b, 'hit');
  console.log(`- ${label}: nDCG ${nd.wins}W/${nd.losses}L z=${nd.z.toFixed(1)} · hit ${h.wins}W/${h.losses}L z=${h.z.toFixed(1)}`);
  pairedOut[key] = { ndcg: nd, hit: h };
}
const errTotal = results.filter((r) => r.errors > 0);
if (errTotal.length > 0) console.log(`\nerrors: ${errTotal.map((r) => `${r.name}=${r.errors}`).join(', ')}`);

writeOut(outArg, {
  corpus,
  split: SPLIT,
  queries: qids.length,
  k: K,
  store: STORE ?? 'sqlite',
  measure_version: MEASURE_VERSION,
  no_silent_change: true,
  variants: Object.fromEntries(shown.map((r) => [r.name, { ndcg: mean(r, 'ndcg'), rr: mean(r, 'rr'), hit: mean(r, 'hit'), ms_per_query: r.ms, errors: r.errors }])),
  paired: pairedOut,
});
