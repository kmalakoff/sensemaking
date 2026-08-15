// Offline model bake-off (semantic-search-design.md, sequence step 2): embed a labeled
// corpus with the candidate static model at each lever setting (f32 / truncated dims /
// int8 storage), score cosine-only and bm25+vector RRF against the qrels, and print the
// numbers next to the acceptance thresholds. No core code — find's future fusion is
// simulated with the same candidate pool and RRF constant as src/commands.ts.
// usage: node benchmark/bakeoff.mjs [corpus] [--queries N] [--k N]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { leverVec, loadModel, MODEL } from './lib/embed.mjs';
import { orBag, readLabels } from './lib/labels.mjs';
import { metrics } from './lib/metrics.mjs';

// Mirror find's internals (src/commands.ts): candidate pool size and RRF constant.
const RRF_K = 60;
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const K = flag('k', 10);
const MAX_QUERIES = flag('queries', Infinity);
const FETCH = Math.max(K * 3, 30);

// Storage levers: docs are stored sliced (+re-normalized) and optionally int8-quantized;
// queries are computed at query time and stay f32 at the lever's dims.
const LEVERS = [
  { name: 'f32-512', dims: 512, int8: false },
  { name: 'f32-256', dims: 256, int8: false },
  { name: 'f32-128', dims: 128, int8: false },
  { name: 'int8-512', dims: 512, int8: true },
  { name: 'int8-256', dims: 256, int8: true },
];

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

const { embedFull, loadMs } = loadModel();

// --- corpus: embed every doc once at full dims (title + body, the future chunk text) ---
const files = readdirSync(tree)
  .filter((f) => f.endsWith('.md'))
  .sort();
const docIds = files.map((f) => f.replace(/\.md$/, ''));
const tEmbed = now();
const docFull = files.map((f) => {
  const raw = readFileSync(join(tree, f), 'utf8');
  const m = raw.match(/^---\ntitle: (.*)\n---\n\n?/);
  let title = '';
  try {
    title = m ? JSON.parse(m[1]) : '';
  } catch {}
  return embedFull(`${title}\n${m ? raw.slice(m[0].length) : raw}`);
});
const embedMsPerDoc = (now() - tEmbed) / files.length;

// --- bm25 candidate lists via the real index (identical SQL to find's candidate query) ---
const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);
const cfg = { scan: { include: ['**/*.md'] }, queries: {}, features: { links: false, rank: false }, baseDir: tree, configPath: null };
const { db } = lib.open(cfg);
const bm25Stmt = db.prepare(`SELECT content.path AS path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED_BM25} LIMIT ${FETCH}`);

const { queries, qrels } = readLabels(labelsDir);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);

let bm25Ms = 0;
const perQuery = qids
  .map((qid) => {
    const text = queries.get(qid);
    if (!text) return null;
    const t0 = now();
    let bm25 = [];
    try {
      bm25 = bm25Stmt.all(orBag(text)).map((r) => r.path.replace(/\.md$/, ''));
    } catch {}
    bm25Ms += now() - t0;
    return { qid, bm25, qFull: embedFull(text) };
  })
  .filter(Boolean);
db.close();
bm25Ms /= perQuery.length;

function topN(qv, docs, dims) {
  const top = [];
  for (let i = 0; i < docs.length; i++) {
    const dv = docs[i];
    let s = 0;
    for (let d = 0; d < dims; d++) s += qv[d] * dv[d];
    if (top.length < FETCH || s > top[top.length - 1].s) {
      top.push({ i, s });
      top.sort((a, b) => b.s - a.s);
      if (top.length > FETCH) top.pop();
    }
  }
  return top.map((t) => docIds[t.i]);
}

function rrf(...lists) {
  const scores = new Map();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const mean = (rows) => {
  const n = rows.length;
  return rows.reduce((acc, m) => ({ ndcg: acc.ndcg + m.ndcg / n, rr: acc.rr + m.rr / n, hit: acc.hit + m.hit / n }), { ndcg: 0, rr: 0, hit: 0 });
};

const bm25Base = mean(perQuery.map((q) => metrics(q.bm25, qrels.get(q.qid), K)));

const rows = [];
for (const lever of LEVERS) {
  const docs = docFull.map((v) => leverVec(v, lever.dims, lever.int8));
  let vecMs = 0;
  const cos = [];
  const fused = [];
  for (const q of perQuery) {
    const t0 = now();
    const qv = leverVec(q.qFull, lever.dims, false);
    const vecTop = topN(qv, docs, lever.dims);
    vecMs += now() - t0;
    cos.push(metrics(vecTop, qrels.get(q.qid), K));
    fused.push(metrics(rrf(q.bm25, vecTop), qrels.get(q.qid), K));
  }
  vecMs /= perQuery.length;
  rows.push({ lever: lever.name, bytes: (files.length * lever.dims * (lever.int8 ? 1 : 4)) / 1e6, cos: mean(cos), fused: mean(fused), vecMs, fusedMs: bm25Ms + vecMs });
}

const f = (v) => v.toFixed(4);
console.log(`corpus: ${corpus} | queries: ${perQuery.length} | k: ${K} | model: ${MODEL.id}@${MODEL.revision.slice(0, 8)}`);
console.log(`model load: ${loadMs.toFixed(0)} ms | embed: ${embedMsPerDoc.toFixed(2)} ms/doc | bm25: ${bm25Ms.toFixed(1)} ms/query\n`);
console.log(`| variant | nDCG@${K} | MRR@${K} | hit@${K} | Δ nDCG | Δ hit | ms/query | vectors MB |`);
console.log('|---|---|---|---|---|---|---|---|');
console.log(`| bm25 (baseline) | ${f(bm25Base.ndcg)} | ${f(bm25Base.rr)} | ${f(bm25Base.hit)} | — | — | ${bm25Ms.toFixed(1)} | — |`);
for (const r of rows) {
  console.log(`| cosine ${r.lever} | ${f(r.cos.ndcg)} | ${f(r.cos.rr)} | ${f(r.cos.hit)} | — | — | ${r.vecMs.toFixed(1)} | ${r.bytes.toFixed(1)} |`);
}
for (const r of rows) {
  console.log(`| bm25+vec ${r.lever} | ${f(r.fused.ndcg)} | ${f(r.fused.rr)} | ${f(r.fused.hit)} | ${f(r.fused.ndcg - bm25Base.ndcg)} | ${f(r.fused.hit - bm25Base.hit)} | ${r.fusedMs.toFixed(1)} | ${r.bytes.toFixed(1)} |`);
}

// Original silent-fusion thresholds, superseded 2026-08-13 by the explicit-expansion
// reframe (semantic-search-design.md "Gate and acceptance") — kept for continuity with
// recorded results; the current bar is recall-when-invoked.
console.log('\nsuperseded silent-fusion thresholds (nfcorpus: ΔnDCG ≥ +0.02, Δhit ≥ +0.03; latency ≤ 2× links-fused ms/query):');
for (const r of rows) {
  const q = r.fused.ndcg - bm25Base.ndcg >= 0.02 && r.fused.hit - bm25Base.hit >= 0.03;
  console.log(`  ${r.lever}: quality ${q ? 'PASS' : 'FAIL'} (ΔnDCG ${f(r.fused.ndcg - bm25Base.ndcg)}, Δhit ${f(r.fused.hit - bm25Base.hit)}), fused ${r.fusedMs.toFixed(1)} ms/query`);
}
