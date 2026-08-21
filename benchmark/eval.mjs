// Retrieval quality in three passes (bm25-only, fused, semantic) plus a hidden guard pass: a
// semantic:false preset must be row-identical to `fused`. Paired deltas with a sign-test z.
// usage: node benchmark/eval.mjs [corpus] [--queries N] [--k N] [--split test|dev]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { orBag, readLabels } from './lib/labels.mjs';
import { metrics } from './lib/metrics.mjs';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const K = Number(flag('k', 10));
const MAX_QUERIES = Number(flag('queries', Infinity));
const SPLIT = flag('split', 'test');

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const { queries, qrels } = readLabels(labelsDir, SPLIT);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);

// embed false -> preset semantic:false, vectors never built. embed true -> vectors build
// lazily on the first participating call.
const VARIANTS = [
  { name: 'bm25-only', features: { links: false, rank: false }, embed: false, searchSemantic: false },
  { name: 'fused', features: undefined, embed: false, searchSemantic: false },
  { name: 'fused-embed-configured', features: undefined, embed: true, searchSemantic: false, hidden: true }, // guard only
  { name: 'semantic', features: undefined, embed: true, searchSemantic: undefined },
];

const results = [];
for (const variant of VARIANTS) {
  const cfg = {
    presets: { default: { include: ['**/*.md'], ...(variant.embed ? {} : { semantic: false }) } },
    features: variant.features,
    queries: {},
    baseDir: tree,
    configPath: null,
  };
  const { db } = lib.open(cfg);
  const perQuery = new Map();
  let errors = 0;
  let ms = 0;
  for (const qid of qids) {
    const text = queries.get(qid);
    if (!text) continue;
    const t0 = process.hrtime.bigint();
    let rows = [];
    try {
      rows = await lib.search(db, cfg, orBag(text), { k: K, semantic: variant.searchSemantic });
    } catch {
      errors++;
    }
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const ranked = rows.map((r) => r.path.replace(/\.md$/, ''));
    perQuery.set(qid, { m: metrics(ranked, qrels.get(qid), K), rows: JSON.stringify(rows) });
  }
  db.close();
  results.push({ ...variant, perQuery, errors, ms: ms / qids.length });
}

// Guard first: semantic:false must fully disable vector participation, even on a corpus
// whose preset has vectors on -- fused-embed-configured must not diverge from fused by a
// single row.
const fused = results.find((r) => r.name === 'fused');
const fusedEmbedConfigured = results.find((r) => r.name === 'fused-embed-configured');
const divergent = qids.filter((qid) => fused.perQuery.get(qid)?.rows !== fusedEmbedConfigured.perQuery.get(qid)?.rows);
if (divergent.length > 0) {
  console.error(`NO-SILENT-CHANGE VIOLATION: semantic:false didn't fully disable vectors on the embed-configured corpus -- ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})`);
  process.exit(1);
}
console.log(`no-silent-change: ok — semantic:false on an embed-configured corpus is row-identical to fused (vectors never built) across ${qids.length} queries\n`);

const mean = (r, key) => [...r.perQuery.values()].reduce((a, q) => a + q.m[key], 0) / qids.length;
const shown = results.filter((r) => !r.hidden);
console.log(`corpus: ${corpus} | split: ${SPLIT} | queries: ${qids.length} | k: ${K} | query form: OR bag of words\n`);
console.log(`| metric | ${shown.map((r) => r.name).join(' | ')} |`);
console.log(`|---|${shown.map(() => '---').join('|')}|`);
for (const [label, key, digits] of [
  [`nDCG@${K}`, 'ndcg', 4],
  [`MRR@${K}`, 'rr', 4],
  [`hit@${K}`, 'hit', 4],
]) {
  console.log(`| ${label} | ${shown.map((r) => mean(r, key).toFixed(digits)).join(' | ')} |`);
}
console.log(`| mean ms/query | ${shown.map((r) => r.ms.toFixed(1)).join(' | ')} |`);

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
for (const [label, a, b] of [
  ['fused vs bm25-only', bm25, fused],
  ['semantic vs fused', fused, semantic],
]) {
  const nd = paired(a, b, 'ndcg');
  const h = paired(a, b, 'hit');
  console.log(`- ${label}: nDCG ${nd.wins}W/${nd.losses}L z=${nd.z.toFixed(1)} · hit ${h.wins}W/${h.losses}L z=${h.z.toFixed(1)}`);
}
const errTotal = results.filter((r) => r.errors > 0);
if (errTotal.length > 0) console.log(`\nerrors: ${errTotal.map((r) => `${r.name}=${r.errors}`).join(', ')}`);
