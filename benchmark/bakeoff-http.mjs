// Offline model bake-off over an OpenAI-shaped HTTP endpoint (Ollama, LM Studio, ...): same
// scoring as bakeoff.mjs (cosine-only and bm25+vector RRF, src/commands.ts's pool/RRF constant)
// but documents and queries are embedded through the library's own openai provider instead of
// a local safetensors matrix. Batches documents at the provider's batchCap.
// usage: node benchmark/bakeoff-http.mjs [corpus] --model <ollama tag> [--url http://localhost:11434/v1] [--queries N] [--k N]
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { corpusLabels, corpusPath } from './lib/corpus.mjs';
import { leverVec } from './lib/embed.mjs';
import { orBag, readLabels } from './lib/labels.mjs';
import { mean, metrics, rrf, topN } from './lib/metrics.mjs';

const RRF_K = 60;
const WEIGHTED_BM25 = 'bm25(content, 10.0, 5.0, 1.0)';

const args = process.argv.slice(2);
const corpus = args.find((a) => !a.startsWith('--')) ?? 'nfcorpus';
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const stringFlag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const K = flag('k', 10);
const MAX_QUERIES = flag('queries', Infinity);
const FETCH = Math.max(K * 3, 30);
const MODEL_ID = stringFlag('model', undefined);
const URL_BASE = stringFlag('url', 'http://localhost:11434/v1');
if (!MODEL_ID) {
  console.error('usage: node benchmark/bakeoff-http.mjs [corpus] --model <tag> [--url <base>]');
  process.exit(2);
}

const tree = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!tree || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

const ROOT = join(new URL('.', import.meta.url).pathname, '..');
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);
const { openaiProvider } = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'embed', 'openai.js')).href);

const tLoad = now();
const provider = await openaiProvider(MODEL_ID, URL_BASE, undefined);
const loadMs = now() - tLoad;
const nativeDims = provider.dims;

// Storage levers: docs are stored sliced (+re-normalized) and optionally int8-quantized;
// queries are computed at query time and stay f32 at the lever's dims. Capped to what this
// model actually produces (a lever wider than native dims would read past the vector).
const ALL_LEVERS = [
  { name: 'int8-256', dims: 256, int8: true },
  { name: `f32-${nativeDims}`, dims: nativeDims, int8: false },
];
const LEVERS = ALL_LEVERS.filter((l) => l.dims <= nativeDims);

// --- corpus: embed every doc once at native dims (title + body), batched at the provider cap ---
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

const tEmbed = now();
const docFull = [];
for (let i = 0; i < docTexts.length; i += provider.batchCap) {
  const batch = docTexts.slice(i, i + provider.batchCap);
  const vecs = await provider.embedDocuments(batch);
  docFull.push(...vecs);
  if ((i / provider.batchCap) % 10 === 0) console.error(`embedding docs: ${i}/${docTexts.length}`);
}
const embedMsPerDoc = (now() - tEmbed) / docTexts.length;

// --- bm25 candidate lists via the real index (identical SQL to find's candidate query) ---
const cfg = { presets: { default: { include: ['**/*.md'], signals: { words: 1 } } }, queries: {}, features: { links: false, rank: false }, baseDir: tree, configPath: null };
const { db } = lib.open(cfg);
const bm25Stmt = db.prepare(`SELECT content.path AS path FROM content WHERE content MATCH ? ORDER BY ${WEIGHTED_BM25} LIMIT ${FETCH}`);

const { queries, qrels } = readLabels(labelsDir);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);

let bm25Ms = 0;
let qEmbedMs = 0;
const perQuery = [];
for (const qid of qids) {
  const text = queries.get(qid);
  if (!text) continue;
  const t0 = now();
  let bm25 = [];
  try {
    bm25 = bm25Stmt.all(orBag(text)).map((r) => r.path.replace(/\.md$/, ''));
  } catch {}
  bm25Ms += now() - t0;
  const t1 = now();
  const qFull = await provider.embedQuery(text);
  qEmbedMs += now() - t1;
  perQuery.push({ qid, bm25, qFull });
}
db.close();
bm25Ms /= perQuery.length;
qEmbedMs /= perQuery.length;

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
    const vecTop = topN(qv, docs, lever.dims, FETCH, docIds);
    vecMs += now() - t0;
    cos.push(metrics(vecTop, qrels.get(q.qid), K));
    fused.push(metrics(rrf(RRF_K, q.bm25, vecTop), qrels.get(q.qid), K));
  }
  vecMs /= perQuery.length;
  rows.push({ lever: lever.name, bytes: (files.length * lever.dims * (lever.int8 ? 1 : 4)) / 1e6, cos: mean(cos), fused: mean(fused), vecMs, fusedMs: bm25Ms + vecMs });
}

const f = (v) => v.toFixed(4);
console.log(`corpus: ${corpus} | queries: ${perQuery.length} | k: ${K} | model: ${MODEL_ID} (${URL_BASE}) | native dims: ${nativeDims}`);
console.log(`provider load (dim probe): ${loadMs.toFixed(0)} ms | embed: ${embedMsPerDoc.toFixed(2)} ms/doc | query embed: ${qEmbedMs.toFixed(1)} ms/query | bm25: ${bm25Ms.toFixed(1)} ms/query\n`);
console.log(`| variant | nDCG@${K} | MRR@${K} | hit@${K} | Δ nDCG | Δ hit | ms/query | vectors MB |`);
console.log('|---|---|---|---|---|---|---|---|');
console.log(`| bm25 (baseline) | ${f(bm25Base.ndcg)} | ${f(bm25Base.rr)} | ${f(bm25Base.hit)} | — | — | ${bm25Ms.toFixed(1)} | — |`);
for (const r of rows) {
  console.log(`| cosine ${r.lever} | ${f(r.cos.ndcg)} | ${f(r.cos.rr)} | ${f(r.cos.hit)} | — | — | ${r.vecMs.toFixed(1)} | ${r.bytes.toFixed(1)} |`);
}
for (const r of rows) {
  console.log(`| bm25+vec ${r.lever} | ${f(r.fused.ndcg)} | ${f(r.fused.rr)} | ${f(r.fused.hit)} | ${f(r.fused.ndcg - bm25Base.ndcg)} | ${f(r.fused.hit - bm25Base.hit)} | ${r.fusedMs.toFixed(1)} | ${r.bytes.toFixed(1)} |`);
}
