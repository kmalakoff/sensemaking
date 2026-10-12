import type { Store } from '../../src/store/types.ts';
import { bareAnd, orBag } from './labels.ts';
import type { QualityMetrics } from './metrics.ts';
import { metrics } from './metrics.ts';

interface QueryProgress {
  completed: number;
  total: number;
  qid: string;
  query_elapsed_ms: number;
  search_ms: number;
}
interface ScoredQuery {
  m: QualityMetrics;
  rows: string;
}
interface QualityVariantResult<E = unknown, M = unknown, W = unknown> {
  workload_identity?: W;
  execution?: E;
  model_observation?: M;
  errors: number;
  error_details: unknown;
  incomplete: boolean;
  ms: number | null;
  perQuery: ReadonlyMap<string, ScoredQuery>;
}

const PROGRESS_QUERY_INTERVAL = 256;

export function queryFormFor(form?: 'or-bag' | 'bare-and'): (text: string) => string;
export function queryFormFor(form: string): ((text: string) => string) | null;
export function queryFormFor(form = 'or-bag') {
  if (form === 'or-bag') return orBag;
  if (form === 'bare-and') return bareAnd;
  return null;
}

export function buildQualityArtifactBase({
  corpus,
  split,
  qids,
  k,
  store,
  source,
  tree,
  measureVersion,
  queries,
  qrels,
  queryForm,
  queryFor,
}: {
  corpus: string;
  split: string;
  qids: readonly string[];
  k: number;
  store: string;
  source: string;
  tree: string | null;
  measureVersion: string;
  queries: ReadonlyMap<string, string>;
  qrels: ReadonlyMap<string, ReadonlyMap<string, number>>;
  queryForm: string;
  queryFor: (text: string) => string;
}) {
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
    query_evidence: Object.fromEntries(qids.map((qid) => [qid, { text: queries.get(qid), canonical: queryFor(queries.get(qid) as string) }])),
    qrels: Object.fromEntries(qids.map((qid) => [qid, Object.fromEntries(qrels.get(qid) as ReadonlyMap<string, number>)])),
  };
}

export function qualityVariantEvidence<E, M, W>(result: QualityVariantResult<E, M, W>) {
  return {
    workload_identity: result.workload_identity ?? null,
    execution: result.execution ?? null,
    model_observation: result.model_observation ?? { status: 'not-applicable' },
    errors: result.errors,
    error_details: result.error_details,
    incomplete: result.incomplete,
    ms_per_query: result.ms,
    per_query: Object.fromEntries([...result.perQuery].map(([qid, query]) => [qid, { ...query.m, paths: (JSON.parse(query.rows) as { path: string }[]).map((row) => row.path) }])),
  };
}

// The or-bag form's ranked BM25 candidates through the store's own lexical index: production SQL,
// column weights and segmentation. A failed query rejects instead of scoring as no match.
export async function orBagCandidates(store: Pick<Store, 'lexical'>, text: string, limit: number) {
  const rows = await store.lexical.query(orBag(text), { whereJoin: '', whereCond: '', scopeCond: '', limit });
  return rows.map((row) => row.path.replace(/\.md$/, ''));
}

// Runs one quality variant until its first invalid query. The caller owns the store lifetime;
// this helper keeps query-level evidence separate from opening and closing the store.
export async function evaluateVariant({
  qids,
  queries,
  qrels,
  k,
  search,
  queryFor = (text) => text,
  onProgress = undefined,
}: {
  qids: readonly string[];
  queries: ReadonlyMap<string, string>;
  qrels: ReadonlyMap<string, ReadonlyMap<string, number>>;
  k: number;
  search: (terms: string, options: { k: number }) => Promise<unknown>;
  queryFor?: (text: string) => unknown;
  onProgress?: (record: QueryProgress) => void;
}) {
  const perQuery = new Map<string, ScoredQuery>();
  const errorDetails: { qid: string; error: string }[] = [];
  const started = process.hrtime.bigint();
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
    let terms: unknown;
    try {
      terms = queryFor(text);
    } catch (err) {
      errorDetails.push({ qid, error: `query form: ${(err as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(err as Partial<Error> | null | undefined)?.message ?? err}` });
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
      const ranked = rows.map((r: unknown, i) => {
        if (r === null || typeof r !== 'object' || typeof (r as { path?: unknown }).path !== 'string') throw new Error(`result row ${i} has no string path`);
        return (r as { path: string }).path.replace(/\.md$/, '');
      });
      const m = metrics(ranked, qrels.get(qid) as ReadonlyMap<string, number>, k);
      perQuery.set(qid, { m, rows: JSON.stringify(rows) });
      // Progress runs after scoring, outside search timing, without adding scheduling yields.
      if (onProgress && (perQuery.size % PROGRESS_QUERY_INTERVAL === 0 || perQuery.size === qids.length)) {
        try {
          onProgress({ completed: perQuery.size, total: qids.length, qid, query_elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6, search_ms: ms });
        } catch (err) {
          errorDetails.push({ qid, error: `progress: ${(err as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(err as Partial<Error> | null | undefined)?.message ?? err}` });
          break;
        }
      }
    } catch (err) {
      if (!searchMsRecorded) ms += Number(process.hrtime.bigint() - t0) / 1e6;
      errorDetails.push({ qid, error: `${(err as Partial<Error> | null | undefined)?.name ?? 'Error'}: ${(err as Partial<Error> | null | undefined)?.message ?? err}` });
      break;
    }
  }
  return { perQuery, errorDetails, incomplete: perQuery.size !== qids.length, ms: perQuery.size > 0 ? ms / perQuery.size : null };
}
