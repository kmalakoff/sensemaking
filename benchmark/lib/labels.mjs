// BEIR-format label reader: queries.jsonl ({_id, text}) + <split>.tsv (query-id, corpus-id,
// score; tab-separated, one header line). Corpus builders that adopt other datasets convert
// their labels into this shape so the eval harness reads one format.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Dataset queries are natural language; bare punctuation is FTS5 syntax and bare words
// AND-join. The standard bag-of-words baseline: OR over the query's tokens.
//
// A \p{L}+ run assumes word-spaced script: for an unspaced script it swallows the whole query
// into one unsplittable run (no spaces to break on), which only ever matches an exact
// contiguous phrase -- measured on miracl-zh pre-fix, nDCG@10 0.0119 (chance). Split those runs
// to one-character unigrams instead, matching Lucene's StandardTokenizer default for CJK;
// word-spaced scripts (Latin, Cyrillic, ...) are untouched. Mirrors src/segment.ts's SCRIPTS.
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
