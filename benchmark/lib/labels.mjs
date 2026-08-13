// BEIR-format label reader: queries.jsonl ({_id, text}) + <split>.tsv (query-id, corpus-id,
// score; tab-separated, one header line). Corpus builders that adopt other datasets convert
// their labels into this shape so the eval harness reads one format.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
