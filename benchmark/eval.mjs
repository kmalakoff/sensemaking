// Retrieval-quality eval over a labeled corpus: runs every labeled query through find()
// in two variants (BM25-only vs BM25+link fusion) and reports ranking metrics. This is
// the instrument behind two gates: whether link fusion earns its keep, and whether BM25
// misses enough to justify embeddings.
// usage: node benchmark/eval.mjs [corpus] [--queries N] [--k N]
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { readLabels } from './lib/labels.mjs';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const K = flag('k', 10);
const MAX_QUERIES = flag('queries', Infinity);

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const { queries, qrels } = readLabels(labelsDir);
// Deterministic subset when capped: sorted query ids, first N.
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);

// Dataset queries are natural language; bare punctuation is FTS5 syntax and bare words
// AND-join. The eval submits the standard bag-of-words baseline: OR over the query's tokens.
const orBag = (text) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t)).join(' OR ');

function metrics(ranked, rels) {
  let dcg = 0;
  let firstRel = 0;
  ranked.slice(0, K).forEach((doc, i) => {
    const rel = rels.get(doc) ?? 0;
    if (rel > 0) {
      dcg += (2 ** rel - 1) / Math.log2(i + 2);
      if (firstRel === 0) firstRel = i + 1;
    }
  });
  let idcg = 0;
  [...rels.values()]
    .sort((a, b) => b - a)
    .slice(0, K)
    .forEach((rel, i) => {
      idcg += (2 ** rel - 1) / Math.log2(i + 2);
    });
  return { ndcg: idcg > 0 ? dcg / idcg : 0, rr: firstRel > 0 ? 1 / firstRel : 0, hit: firstRel > 0 ? 1 : 0 };
}

const VARIANTS = [
  { name: 'bm25-only', features: { links: false, rank: false } },
  { name: 'fused', features: undefined },
];

const results = [];
for (const variant of VARIANTS) {
  const cfg = { scan: { include: ['**/*.md'] }, queries: {}, features: variant.features, baseDir: tree, configPath: null };
  const { db } = lib.open(cfg);
  let ndcg = 0;
  let rr = 0;
  let hit = 0;
  let errors = 0;
  let ms = 0;
  for (const qid of qids) {
    const text = queries.get(qid);
    if (!text) continue;
    const t0 = process.hrtime.bigint();
    let ranked = [];
    try {
      ranked = lib.find(db, cfg, orBag(text), { k: K }).map((r) => r.path.replace(/\.md$/, ''));
    } catch {
      errors++;
    }
    ms += Number(process.hrtime.bigint() - t0) / 1e6;
    const m = metrics(ranked, qrels.get(qid));
    ndcg += m.ndcg;
    rr += m.rr;
    hit += m.hit;
  }
  db.close();
  const n = qids.length;
  results.push({ name: variant.name, ndcg: ndcg / n, mrr: rr / n, hit: hit / n, ms: ms / n, errors });
}

console.log(`corpus: ${corpus} | queries: ${qids.length} | k: ${K} | query form: OR bag of words\n`);
console.log(`| metric | ${results.map((r) => r.name).join(' | ')} | delta |`);
console.log(`|---|${results.map(() => '---').join('|')}|---|`);
const row = (label, get, fmt) => {
  const vals = results.map(get);
  console.log(`| ${label} | ${vals.map(fmt).join(' | ')} | ${fmt(vals[1] - vals[0], true)} |`);
};
row(
  `nDCG@${K}`,
  (r) => r.ndcg,
  (v) => v.toFixed(4)
);
row(
  `MRR@${K}`,
  (r) => r.mrr,
  (v) => v.toFixed(4)
);
row(
  `hit@${K}`,
  (r) => r.hit,
  (v) => v.toFixed(4)
);
row(
  'mean ms/query',
  (r) => r.ms,
  (v) => v.toFixed(1)
);
if (results.some((r) => r.errors > 0)) console.log(`\nerrors: ${results.map((r) => `${r.name}=${r.errors}`).join(', ')}`);
