// Vector-signal weight sweep: how RRF-fusion nDCG responds to a vectors weight, at fixed pool
// (fetch), through the same scoring bakeoff.mjs/bakeoff-http.mjs use (their own BM25 SQL, their
// own weighted-RRF combiner) -- not search()'s signals path, same as fusion-sweep.mjs. Static
// model path reuses lib/embed.mjs's local Model2Vec loader; --model routes through the shipped
// openai provider over an OpenAI-shaped HTTP endpoint (Ollama, LM Studio, ...), same as
// bakeoff-http.mjs.
// usage:
//   node benchmark/weight-sweep.mjs nfcorpus [--k N]
//   node benchmark/weight-sweep.mjs miracl-zh --model qwen3-embedding:0.6b [--url http://localhost:11434/v1] [--k N]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { leverVec, loadModel } from './lib/embed.mjs';
import { orBag, readLabels } from './lib/labels.mjs';
import { mean, metrics } from './lib/metrics.mjs';

const RRF_K = 60;
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';
const WEIGHTS = [0.5, 1, 2, 4];

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const K = Number(flag('k', 10));
const MODEL_ID = flag('model', undefined);
const URL_BASE = flag('url', 'http://localhost:11434/v1');
const FETCH = Math.max(K * 3, 30);

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const files = readdirSync(tree)
  .filter((f) => f.endsWith('.md'))
  .sort();
const docIds = files.map((f) => f.replace(/\.md$/, ''));
const docTexts = files.map((f) => {
  const raw = readFileSync(join(tree, f), 'utf8');
  const m = raw.match(/^---\ntitle: (.*)\n---\n\n?/);
  let title = '';
  try {
    title = m ? JSON.parse(m[1]) : '';
  } catch {}
  return `${title}\n${m ? raw.slice(m[0].length) : raw}`;
});

// Both branches produce: docVecs (f32, native dims), embedQuery(text) -> f32 vector, modelLabel.
let docVecs;
let embedQuery;
let modelLabel;
if (MODEL_ID) {
  const { openaiProvider } = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'embed', 'openai.js')).href);
  const provider = await openaiProvider(MODEL_ID, URL_BASE, undefined);
  const dims = provider.dims;
  const vecs = [];
  for (let i = 0; i < docTexts.length; i += provider.batchCap) {
    const batch = docTexts.slice(i, i + provider.batchCap);
    vecs.push(...(await provider.embedDocuments(batch)));
    console.error(`embedding docs: ${Math.min(i + provider.batchCap, docTexts.length)}/${docTexts.length}`);
  }
  docVecs = vecs.map((v) => leverVec(v, dims, false));
  embedQuery = async (text) => leverVec(await provider.embedQuery(text), dims, false);
  modelLabel = `${MODEL_ID} (${URL_BASE}), native dims ${dims}, f32`;
} else {
  const { embedFull, id, sha } = await loadModel();
  const DIMS = 512; // potion-retrieval-32M's native dims
  docVecs = [];
  for (const t of docTexts) docVecs.push(leverVec(await embedFull(t), DIMS, false));
  embedQuery = async (text) => leverVec(await embedFull(text), DIMS, false);
  modelLabel = `${id}@${sha.slice(0, 8)}, f32-${DIMS}`;
}

// bm25 candidate lists via the real index -- identical SQL to find's candidate query, same as
// bakeoff.mjs/bakeoff-http.mjs.
const cfg = { presets: { default: { include: ['**/*.md'], signals: { words: 1 } } }, queries: {}, features: { links: false, rank: false }, baseDir: tree, configPath: null };
const { db } = lib.open(cfg);
const bm25Stmt = db.prepare(`SELECT content.path AS path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED_BM25} LIMIT ${FETCH}`);

const { queries, qrels } = readLabels(labelsDir);
const qids = [...qrels.keys()].sort();

function topN(qv, n) {
  const top = [];
  for (let i = 0; i < docVecs.length; i++) {
    const dv = docVecs[i];
    let s = 0;
    for (let d = 0; d < dv.length; d++) s += qv[d] * dv[d];
    if (top.length < n || s > top[top.length - 1].s) {
      top.push({ i, s });
      top.sort((a, b) => b.s - a.s);
      if (top.length > n) top.pop();
    }
  }
  return top.map((t) => docIds[t.i]);
}

const perQuery = [];
for (const qid of qids) {
  const text = queries.get(qid);
  if (!text) continue;
  let bm25 = [];
  try {
    bm25 = bm25Stmt.all(orBag(text)).map((r) => r.path.replace(/\.md$/, ''));
  } catch {}
  const qv = await embedQuery(text);
  perQuery.push({ qid, bm25, vec: topN(qv, FETCH) });
}
db.close();

// Same weighted-RRF combiner as fusion-sweep.mjs: bm25 contributes 1/(k+i), vectors w/(k+j) --
// the same shape search()'s signal weights compose (weight * 1/(RRF_K + rank)).
function rrfW(bm25, vec, w) {
  const scores = new Map();
  bm25.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i)));
  vec.forEach((id, j) => scores.set(id, (scores.get(id) ?? 0) + w / (RRF_K + j)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

const f = (v) => v.toFixed(4);
const bm25Only = mean(perQuery.map((q) => metrics(q.bm25, qrels.get(q.qid), K)));
const vectorsOnly = mean(perQuery.map((q) => metrics(q.vec, qrels.get(q.qid), K)));

console.log(`corpus: ${corpus} | queries: ${perQuery.length} | k: ${K} | model: ${modelLabel}`);
console.log(`\n| variant | nDCG@${K} | MRR@${K} | hit@${K} |`);
console.log('|---|---|---|---|');
console.log(`| bm25 only (weight n/a) | ${f(bm25Only.ndcg)} | ${f(bm25Only.rr)} | ${f(bm25Only.hit)} |`);
for (const w of WEIGHTS) {
  const m = mean(perQuery.map((q) => metrics(rrfW(q.bm25, q.vec, w), qrels.get(q.qid), K)));
  console.log(`| bm25 + vectors\\*${w} | ${f(m.ndcg)} | ${f(m.rr)} | ${f(m.hit)} |`);
}
console.log(`| vectors only (cosine, no bm25) | ${f(vectorsOnly.ndcg)} | ${f(vectorsOnly.rr)} | ${f(vectorsOnly.hit)} |`);
