// BEIR-format label reader: queries.jsonl ({_id, text}) + <split>.tsv (query-id, corpus-id,
// score; one header line). Other datasets convert to this shape so the harness reads one format.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bag-of-words baseline: OR over tokens (bare FTS5 words AND-join). Unspaced-script runs become
// one-character unigrams (Lucene's CJK default): a whole run matched only exact phrases, nDCG@10 0.0119 (chance) on miracl-zh.
const CJK = /\p{scx=Han}|\p{scx=Hiragana}|\p{scx=Katakana}|\p{scx=Thai}|\p{scx=Khmer}|\p{scx=Lao}|\p{scx=Myanmar}/u;
export const orBag = (text) =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .flatMap((run) => (CJK.test(run) ? [...run] : [run]))
    .filter((t) => !['AND', 'OR', 'NOT', 'NEAR'].includes(t))
    .join(' OR ');

export function readLabels(labelsDir, split = 'test') {
  const queries = new Map();
  for (const line of readFileSync(join(labelsDir, 'queries.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const q = JSON.parse(line);
    queries.set(String(q._id), q.text);
  }
  const qrels = new Map();
  const rows = readFileSync(join(labelsDir, `${split}.tsv`), 'utf8')
    .split('\n')
    .slice(1);
  for (const row of rows) {
    if (!row.trim()) continue;
    const [qid, docid, score] = row.split('\t');
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    qrels.get(qid).set(docid, Number(score));
  }
  return { queries, qrels };
}
