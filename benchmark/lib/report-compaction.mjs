import { identityHash } from './workload-identity.mjs';

const evidenceSummary = (field, value) => ({
  field,
  canonical_sha256: identityHash(value),
  bytes: Buffer.byteLength(JSON.stringify(value)),
  ...(Array.isArray(value) ? { items: value.length } : {}),
});

const evidenceHashes = (value) => Object.fromEntries(Object.entries(value ?? {}).map(([id, evidence]) => [id, identityHash(evidence)]));

export function compactRetainedQuality(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const compact = { ...record };
  for (const [field, hashesField] of [
    ['source_compact', 'source_compact_hashes'],
    ['artifacts', 'artifact_hashes'],
  ]) {
    if (!Object.hasOwn(compact, field)) continue;
    compact[hashesField] = evidenceHashes(compact[field]);
    delete compact[field];
  }
  return compact;
}

export function compactStep(id, step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  const compact = id === 'retained-quality' ? compactRetainedQuality(step) : JSON.parse(JSON.stringify(step));
  const omitted = [];
  const omit = (object, field, label = field) => {
    if (!Object.hasOwn(object, field)) return;
    omitted.push(evidenceSummary(label, object[field]));
    delete object[field];
  };

  if (id === 'store-dump') {
    omit(compact, 'stores');
    if (compact.diff && typeof compact.diff === 'object') {
      const rawDiff = compact.diff;
      const categories = rawDiff.categories;
      compact.diff = {
        categories: Object.fromEntries(Object.entries(categories ?? {}).map(([category, entries]) => [category, Array.isArray(entries) ? entries.length : Number.isSafeInteger(entries) ? entries : 0])),
      };
      omitted.push(evidenceSummary('diff', rawDiff));
    }
  }
  for (const field of ['query_evidence', 'qrels']) omit(compact, field);
  for (const [name, variant] of Object.entries(compact.variants ?? {})) {
    if (variant && typeof variant === 'object') omit(variant, 'per_query', `variants.${name}.per_query`);
  }
  return omitted.length === 0
    ? compact
    : {
        ...compact,
        omitted_evidence: {
          retention: 'Raw evidence is retained only in the named sitting. This compact release record cannot revalidate omitted evidence.',
          fields: omitted,
        },
      };
}
