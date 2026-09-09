// Cosine top-N by brute force with an n-bounded insertion (n is a candidate pool size, not
// the corpus size), returning doc ids via the parallel `ids` array.
export function topN(qv, docs, dims, n, ids) {
  const top = [];
  for (let i = 0; i < docs.length; i++) {
    const dv = docs[i];
    let s = 0;
    for (let d = 0; d < dims; d++) s += qv[d] * dv[d];
    if (top.length < n || s > top[top.length - 1].s) {
      top.push({ i, s });
      top.sort((a, b) => b.s - a.s);
      if (top.length > n) top.pop();
    }
  }
  return top.map((t) => ids[t.i]);
}

// Unweighted reciprocal-rank fusion over any number of ranked id lists, rrfK matching
// search()'s own constant.
export function rrf(rrfK, ...lists) {
  const scores = new Map();
  for (const list of lists) list.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (rrfK + i)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// Per-query metrics averaged over a run.
export function mean(rows) {
  const n = rows.length;
  const totals = rows.reduce((acc, m) => ({ ndcg: acc.ndcg + m.ndcg, rr: acc.rr + m.rr, hit: acc.hit + m.hit }), { ndcg: 0, rr: 0, hit: 0 });
  return { ndcg: totals.ndcg / n, rr: totals.rr / n, hit: totals.hit / n };
}

const QUALITY_RANGES = { ndcg: [0, 1], rr: [0, 1], hit: [0, 1] };

// Persisted quality rows are bounded probabilities/scores. Keep this validator shared with the
// report classifier so malformed current and prior artifacts cannot enter a comparison.
export function metricRangeError(key, value) {
  const range = QUALITY_RANGES[key];
  if (!range) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${key} must be a finite number`;
  if (value < range[0] || value > range[1]) return `${key} must be between ${range[0]} and ${range[1]}`;
  return null;
}

export function rankingInputError(ranked, rels, K) {
  if (!Array.isArray(ranked)) return 'ranked results must be an array';
  if (!Number.isSafeInteger(K) || K < 1) return 'cutoff K must be a positive integer';
  if (!(rels instanceof Map)) return 'qrels must be a Map';
  const seen = new Set();
  for (let i = 0; i < ranked.length; i++) {
    const id = ranked[i];
    if (typeof id !== 'string' || id.trim().length === 0) return `ranked result ${i} has an empty or non-string id`;
    if (seen.has(id)) return `ranked results contain duplicate id "${id}"`;
    seen.add(id);
  }
  for (const [id, grade] of rels) {
    if (typeof id !== 'string' || id.trim().length === 0) return 'qrels contain an empty or non-string document id';
    if (typeof grade !== 'number' || !Number.isFinite(grade) || grade < 0) return `qrel "${id}" has a malformed grade`;
    if (!Number.isFinite(2 ** grade)) return `qrel "${id}" grade produces a non-finite gain`;
  }
  return null;
}

// Ranking metrics: one ranked id list vs graded qrels, cutoff K.
export function metrics(ranked, rels, K) {
  const error = rankingInputError(ranked, rels, K);
  if (error) throw new Error(error);
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
  const result = { ndcg: idcg > 0 ? dcg / idcg : 0, rr: firstRel > 0 ? 1 / firstRel : 0, hit: firstRel > 0 ? 1 : 0 };
  for (const [key, value] of Object.entries(result)) {
    const rangeError = metricRangeError(key, value);
    if (rangeError) throw new Error(rangeError);
  }
  return result;
}
