// BEIR-format label reader: queries.jsonl ({_id, text}) + <split>.tsv (query-id, corpus-id,
// score; one header line). Other datasets convert to this shape so the harness reads one format.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Bag-of-words baseline: OR over tokens (bare FTS5 words AND-join). Unspaced-script runs become
// one-character unigrams (Lucene's CJK default): a whole run matched only exact phrases, nDCG@10 0.0119 (chance) on miracl-zh.
const CJK = /\p{scx=Han}|\p{scx=Hiragana}|\p{scx=Katakana}|\p{scx=Thai}|\p{scx=Khmer}|\p{scx=Lao}|\p{scx=Myanmar}/u;
const OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);
export const orBag = (text) =>
  (text.match(/[\p{L}\p{N}]+/gu) ?? [])
    .flatMap((run) => (CJK.test(run) ? [...run] : [run]))
    .filter((t) => !OPERATORS.has(t))
    .join(' OR ');

const bareGroups = (text) => (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []).filter((run) => !OPERATORS.has(run));
// Bare-and keeps each unspaced-script run intact as a shared query spelling. It does not claim
// that the adapters tokenize those scripts identically; Latin runs remain separate required terms.
export const bareAnd = (text) => bareGroups(text).join(' ');

function invalidLabels(message) {
  throw new Error(`invalid labels: ${message}`);
}

export function readLabels(labelsDir, split = 'test') {
  const queries = new Map();
  for (const [lineNumber, line] of readFileSync(join(labelsDir, 'queries.jsonl'), 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let q;
    try {
      q = JSON.parse(line);
    } catch (err) {
      invalidLabels(`queries.jsonl line ${lineNumber + 1} is not JSON: ${err?.message ?? err}`);
    }
    if (q === null || typeof q !== 'object' || Array.isArray(q) || !['string', 'number'].includes(typeof q._id) || String(q._id).trim().length === 0 || (typeof q._id === 'number' && !Number.isFinite(q._id))) invalidLabels(`queries.jsonl line ${lineNumber + 1} is missing a nonempty _id`);
    const qid = String(q._id);
    if (typeof q.text !== 'string' || q.text.trim().length === 0) invalidLabels(`queries.jsonl line ${lineNumber + 1} is missing query text for ${qid}`);
    if (queries.has(qid)) invalidLabels(`queries.jsonl repeats query id ${qid}`);
    queries.set(qid, q.text);
  }
  const qrels = new Map();
  const lines = readFileSync(join(labelsDir, `${split}.tsv`), 'utf8').split(/\r?\n/);
  if (lines.length === 0 || lines[0] !== 'query-id\tcorpus-id\tscore') invalidLabels(`${split}.tsv has an unexpected header`);
  for (const [lineNumber, row] of lines.slice(1).entries()) {
    if (!row.trim()) continue;
    const fields = row.split('\t');
    if (fields.length !== 3) invalidLabels(`${split}.tsv line ${lineNumber + 2} must have query-id, corpus-id, and score`);
    const [qid, docid, score] = fields;
    if (qid.trim().length === 0 || docid.trim().length === 0) invalidLabels(`${split}.tsv line ${lineNumber + 2} has an empty query or document id`);
    const numericScore = Number(score);
    if (score.trim().length === 0 || !Number.isFinite(numericScore) || numericScore < 0) invalidLabels(`${split}.tsv line ${lineNumber + 2} has a malformed score for ${qid}/${docid}`);
    if (!queries.has(qid)) invalidLabels(`${split}.tsv line ${lineNumber + 2} references missing query id ${qid}`);
    if (!qrels.has(qid)) qrels.set(qid, new Map());
    if (qrels.get(qid).has(docid)) invalidLabels(`${split}.tsv repeats qrel ${qid}/${docid}`);
    qrels.get(qid).set(docid, numericScore);
  }
  return { queries, qrels };
}
