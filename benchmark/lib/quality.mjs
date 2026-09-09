import { bareAnd, orBag } from './labels.mjs';
import { metrics } from './metrics.mjs';

export function queryFormFor(form = 'or-bag') {
  if (form === 'or-bag') return orBag;
  if (form === 'bare-and') return bareAnd;
  return null;
}

export function buildQualityArtifactBase({ corpus, split, qids, k, store, source, tree, measureVersion, queries, qrels, queryForm, queryFor }) {
  return {
    corpus,
    split,
    queries: qids.length,
    k,
    store,
    source_tree: source,
    work_tree: tree,
    measure_version: measureVersion,
    query_form: queryForm,
    query_evidence: Object.fromEntries(qids.map((qid) => [qid, { text: queries.get(qid), canonical: queryFor(queries.get(qid)) }])),
    qrels: Object.fromEntries(qids.map((qid) => [qid, Object.fromEntries(qrels.get(qid))])),
  };
}

export function qualityVariantEvidence(result) {
  return {
    workload_identity: result.workload_identity ?? null,
    execution: result.execution ?? null,
    model_observation: result.model_observation ?? { status: 'not-applicable' },
    errors: result.errors,
    error_details: result.error_details,
    incomplete: result.incomplete,
    ms_per_query: result.ms,
    per_query: Object.fromEntries([...result.perQuery].map(([qid, query]) => [qid, { ...query.m, paths: JSON.parse(query.rows).map((row) => row.path) }])),
  };
}

// Runs one quality variant until its first invalid query. The caller owns the store lifetime;
// this helper keeps query-level evidence separate from opening and closing the store.
export async function evaluateVariant({ qids, queries, qrels, k, search, queryFor = (text) => text }) {
  const perQuery = new Map();
  const errorDetails = [];
  let ms = 0;
  for (const qid of qids) {
    const text = queries.get(qid);
    if (typeof text !== 'string' || text.trim().length === 0) {
      errorDetails.push({ qid, error: 'missing query text' });
      break;
    }
    if (!(qrels instanceof Map) || !qrels.has(qid)) {
      errorDetails.push({ qid, error: 'missing qrels for query' });
      break;
    }
    let terms;
    try {
      terms = queryFor(text);
    } catch (err) {
      errorDetails.push({ qid, error: `query form: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
      break;
    }
    if (typeof terms !== 'string' || terms.trim().length === 0) {
      errorDetails.push({ qid, error: 'query form produced an empty query' });
      break;
    }
    const t0 = process.hrtime.bigint();
    let searchMsRecorded = false;
    try {
      const rows = await search(terms, { k });
      ms += Number(process.hrtime.bigint() - t0) / 1e6;
      searchMsRecorded = true;
      if (!Array.isArray(rows)) throw new Error('search returned a non-array result');
      const ranked = rows.map((r, i) => {
        if (r === null || typeof r !== 'object' || typeof r.path !== 'string') throw new Error(`result row ${i} has no string path`);
        return r.path.replace(/\.md$/, '');
      });
      const m = metrics(ranked, qrels.get(qid), k);
      perQuery.set(qid, { m, rows: JSON.stringify(rows) });
    } catch (err) {
      if (!searchMsRecorded) ms += Number(process.hrtime.bigint() - t0) / 1e6;
      errorDetails.push({ qid, error: `${err?.name ?? 'Error'}: ${err?.message ?? err}` });
      break;
    }
  }
  return { perQuery, errorDetails, incomplete: perQuery.size !== qids.length, ms: perQuery.size > 0 ? ms / perQuery.size : null };
}
