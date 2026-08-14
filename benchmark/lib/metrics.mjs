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
