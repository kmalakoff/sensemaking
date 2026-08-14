// Dev sweep for the constants that survive the explicit-expansion design (2026-08-13
// correction: vectors are per-query opt-in, so the lexical-confidence gate is superseded —
// the caller states what it would have inferred; this sweep's earlier gate run showed hard
// gates hurt NFCorpus and soft gates were flat, consistent with dropping it). What remains
// tunable under the fusion-tuning protocol: the vector candidate pool and the vector
// list's RRF weight when expansion is invoked. Reports paired per-query deltas vs the
// bake-off shape (w=1, pool=30). Dev only — test runs and the FEVER guard are eval-side.
// usage: node benchmark/sweep.mjs [corpus] [--split dev] [--dims 256] [--f32] [--k N]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { leverVec, loadModel, MODEL } from './lib/embed.mjs';
import { orBag, readLabels } from './lib/labels.mjs';
import { metrics } from './lib/metrics.mjs';

const RRF_K = 60;
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const K = Number(flag('k', 10));
const SPLIT = flag('split', 'dev');
const DIMS = Number(flag('dims', 256));
const INT8 = !args.includes('--f32');
const FETCH = Math.max(K * 3, 30);

const POOLS = [10, 30, 60];
const WEIGHTS = [0.25, 0.5, 0.75, 1, 1.5];
const MAX_POOL = Math.max(...POOLS);

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const { embedFull } = loadModel();

const files = readdirSync(tree)
  .filter((f) => f.endsWith('.md'))
  .sort();
const docIds = files.map((f) => f.replace(/\.md$/, ''));
const docs = files.map((f) => {
  const raw = readFileSync(join(tree, f), 'utf8');
  const m = raw.match(/^---\ntitle: (.*)\n---\n\n?/);
  let title = '';
  try {
    title = m ? JSON.parse(m[1]) : '';
  } catch {}
  return leverVec(embedFull(`${title}\n${m ? raw.slice(m[0].length) : raw}`), DIMS, INT8);
});

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);
const cfg = { scan: { include: ['**/*.md'] }, queries: {}, features: { links: false, rank: false }, baseDir: tree, configPath: null };
const { db } = lib.open(cfg);
const bm25Stmt = db.prepare(`SELECT content.path AS path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED_BM25} LIMIT ${FETCH}`);

const { queries, qrels } = readLabels(labelsDir, SPLIT);
const qids = [...qrels.keys()].sort();

function topN(qv, n) {
  const top = [];
  for (let i = 0; i < docs.length; i++) {
    const dv = docs[i];
    let s = 0;
    for (let d = 0; d < DIMS; d++) s += qv[d] * dv[d];
    if (top.length < n || s > top[top.length - 1].s) {
      top.push({ i, s });
      top.sort((a, b) => b.s - a.s);
      if (top.length > n) top.pop();
    }
  }
  return top.map((t) => docIds[t.i]);
}

const perQuery = qids
  .map((qid) => {
    const text = queries.get(qid);
    if (!text) return null;
    let bm25 = [];
    try {
      bm25 = bm25Stmt.all(orBag(text)).map((r) => r.path.replace(/\.md$/, ''));
    } catch {}
    return { qid, bm25, vec: topN(leverVec(embedFull(text), DIMS, false), MAX_POOL) };
  })
  .filter(Boolean);
db.close();

// RRF with a weighted vector list: bm25 contributes 1/(k+i), vectors w/(k+j).
function rrfW(bm25, vec, w) {
  const scores = new Map();
  bm25.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i)));
  vec.forEach((id, j) => scores.set(id, (scores.get(id) ?? 0) + w / (RRF_K + j)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

function signTest(up, down) {
  const n = up + down;
  if (n === 0) return 1;
  let t = 0.5 ** n;
  let p = 0;
  for (let i = 0; i <= Math.min(up, down); i++) {
    p += t;
    t = (t * (n - i)) / (i + 1);
  }
  return Math.min(1, 2 * p);
}

const mean = (rows) => {
  const n = rows.length;
  return rows.reduce((acc, m) => ({ ndcg: acc.ndcg + m.ndcg / n, rr: acc.rr + m.rr / n, hit: acc.hit + m.hit / n }), { ndcg: 0, rr: 0, hit: 0 });
};

const baseline = perQuery.map((q) => metrics(rrfW(q.bm25, q.vec.slice(0, 30), 1), qrels.get(q.qid), K));
const bm25Only = mean(perQuery.map((q) => metrics(q.bm25, qrels.get(q.qid), K)));

const f = (v) => v.toFixed(4);
console.log(`corpus: ${corpus} | split: ${SPLIT} | queries: ${perQuery.length} | k: ${K} | lever: ${INT8 ? 'int8' : 'f32'}-${DIMS} | model: ${MODEL.id}@${MODEL.revision.slice(0, 8)}`);
console.log('paired columns compare per-query nDCG vs the bake-off shape (w=1, pool=30)\n');
console.log(`| bm25 only | ${f(bm25Only.ndcg)} | ${f(bm25Only.rr)} | ${f(bm25Only.hit)} |`);
console.log(`\n| pool | w | nDCG@${K} | MRR@${K} | hit@${K} | up | down | tie | p |`);
console.log('|---|---|---|---|---|---|---|---|---|');
for (const pool of POOLS) {
  for (const w of WEIGHTS) {
    const per = perQuery.map((q) => metrics(rrfW(q.bm25, q.vec.slice(0, pool), w), qrels.get(q.qid), K));
    const m = mean(per);
    let up = 0;
    let down = 0;
    let tie = 0;
    per.forEach((x, i) => {
      const d = x.ndcg - baseline[i].ndcg;
      if (d > 1e-12) up++;
      else if (d < -1e-12) down++;
      else tie++;
    });
    console.log(`| ${pool} | ${w} | ${f(m.ndcg)} | ${f(m.rr)} | ${f(m.hit)} | ${up} | ${down} | ${tie} | ${signTest(up, down).toFixed(3)} |`);
  }
}
