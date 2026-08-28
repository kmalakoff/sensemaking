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
  return rows.reduce((acc, m) => ({ ndcg: acc.ndcg + m.ndcg / n, rr: acc.rr + m.rr / n, hit: acc.hit + m.hit / n }), { ndcg: 0, rr: 0, hit: 0 });
}

// Ranking metrics: one ranked id list vs graded qrels, cutoff K.
export function metrics(ranked, rels, K) {
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
