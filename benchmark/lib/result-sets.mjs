// Result-set evidence describes native ranking differences. It is not a correctness oracle or
// a timing row: authored fixtures and relevance judgments remain the independent oracles.
import { identityHash } from './workload-identity.mjs';

export const RESULT_SET_SCHEMA = 'result-sets-v1';

// These are the three ranked searches used by measure-tree. Keep their argv explicit so a saved
// artifact says exactly which query and preset each store received.
export const RESULT_SET_QUERIES = Object.freeze([
  { id: 'lexical', argv: (k) => ['search', 'the', '--preset', 'lexical', '--k', String(k), '--format', 'json'] },
  { id: 'words', argv: (k) => ['search', 'the', '--preset', 'words', '--k', String(k), '--format', 'json'] },
  { id: 'default', argv: (k) => ['search', 'the', '--k', String(k), '--format', 'json'] },
]);

export const RESULT_SET_QUERY_IDS = RESULT_SET_QUERIES.map(({ id }) => id);

export function queryDefinitions(ids, k) {
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) throw new Error('result-set query list contains duplicates');
  const definitions = RESULT_SET_QUERIES.filter(({ id }) => wanted.has(id)).map(({ id, argv }) => ({ id, argv: argv(k) }));
  if (definitions.length !== ids.length) throw new Error(`unknown result-set query; expected ${RESULT_SET_QUERY_IDS.join(', ')}`);
  return definitions;
}

function setOf(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} paths are not an array`);
  if (paths.some((path) => typeof path !== 'string' || path.length === 0)) throw new Error(`${label} paths contain a nonempty string violation`);
  const set = new Set(paths);
  if (set.size !== paths.length) throw new Error(`${label} paths contain duplicates`);
  return set;
}

// Jaccard and path differences are descriptive evidence about the work each store selected.
// They deliberately do not say which ranking is correct, and do not impose a threshold.
export function pairwisePathOverlap(a, b) {
  const pathsA = setOf(a.paths, 'left result');
  const pathsB = setOf(b.paths, 'right result');
  const shared = [...pathsA].filter((path) => pathsB.has(path));
  const onlyA = [...pathsA].filter((path) => !pathsB.has(path));
  const onlyB = [...pathsB].filter((path) => !pathsA.has(path));
  const union = new Set([...pathsA, ...pathsB]);
  return {
    shared_paths: shared.length,
    union_paths: union.size,
    jaccard_path: union.size === 0 ? 1 : shared.length / union.size,
    // Two empty result sets have no top result; report that as not-applicable rather than a
    // coincidental match. A true top-1 comparison requires one result from each side.
    top1_same: a.paths.length > 0 && b.paths.length > 0 && a.paths[0] === b.paths[0],
    only_a: onlyA,
    only_b: onlyB,
  };
}

export function overlapByStore(results, stores) {
  const out = {};
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const left = stores[i];
      const right = stores[j];
      out[`${left}|${right}`] = pairwisePathOverlap(results[left], results[right]);
    }
  }
  return out;
}

export function resultSetWorkload({ corpus, queries, k, config }) {
  return {
    fingerprint: identityHash({ corpus, queries, k, config }),
    inputs: { corpus, queries, k, config },
  };
}

export function validateResultSetArtifact(artifact, { measureVersion, stores }) {
  const errors = [];
  if (artifact?.schema !== RESULT_SET_SCHEMA) errors.push(`schema is not ${RESULT_SET_SCHEMA}`);
  if (artifact?.measure_version !== measureVersion) errors.push(`measure_version ${artifact?.measure_version ?? 'missing'} does not match ${measureVersion}`);
  if (artifact?.valid !== true || artifact?.status !== 'success') errors.push('artifact is not a successful result-set capture');
  if (!Array.isArray(artifact?.errors) || artifact.errors.length > 0) errors.push('artifact contains capture errors');
  if (!Array.isArray(artifact?.stores) || identityHash(artifact.stores) !== identityHash(stores)) errors.push('declared store set differs from required stores');
  if (!Number.isSafeInteger(artifact?.k) || artifact.k < 1) errors.push('k is invalid');
  const queryIds = artifact?.queries?.map((query) => query?.id);
  if (!Array.isArray(artifact?.queries) || artifact.queries.length === 0) {
    errors.push('query definitions are missing');
  } else {
    try {
      const expectedQueries = queryDefinitions(queryIds, artifact.k);
      if (identityHash(expectedQueries) !== identityHash(artifact.queries)) errors.push('query definitions do not match k');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (artifact?.config === undefined || artifact.config_fingerprint !== identityHash(artifact.config)) errors.push('config fingerprint does not recompute');
  for (const [corpusName, corpus] of Object.entries(artifact?.corpora ?? {})) {
    const workload = corpus?.workload;
    if (!workload || workload.fingerprint !== identityHash(workload.inputs ?? {})) errors.push(`${corpusName}: workload fingerprint does not recompute`);
    for (const store of stores) {
      const result = corpus?.stores?.[store];
      if (!result) {
        errors.push(`${corpusName}: missing ${store} result`);
        continue;
      }
      if (result.workload_fingerprint !== workload?.fingerprint) errors.push(`${corpusName}/${store}: workload identity differs`);
      for (const query of artifact.queries ?? []) {
        const resultQuery = result.queries?.[query.id];
        if (!resultQuery) {
          errors.push(`${corpusName}/${store}/${query.id}: missing result`);
          continue;
        }
        try {
          const recomputed = pairwisePathOverlap(resultQuery, resultQuery);
          if (resultQuery.fingerprint !== identityHash(resultQuery.paths) || recomputed.union_paths !== resultQuery.paths.length) errors.push(`${corpusName}/${store}/${query.id}: result identity is invalid`);
        } catch (error) {
          errors.push(`${corpusName}/${store}/${query.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const query of artifact.queries ?? []) {
      try {
        const current = Object.fromEntries(stores.map((store) => [store, corpus.stores[store].queries[query.id]]));
        const expected = overlapByStore(current, stores);
        if (identityHash(expected) !== identityHash(corpus.overlap?.[query.id])) errors.push(`${corpusName}/${query.id}: persisted overlap does not recompute`);
      } catch (error) {
        errors.push(`${corpusName}/${query.id}: overlap cannot be recomputed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (Object.keys(artifact?.corpora ?? {}).length === 0) errors.push('artifact has no corpora');
  return errors;
}
