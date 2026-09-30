import { normalizeStoreDumpEvidence, STORE_DUMP_EVIDENCE_VERSION } from './store-dump-evidence.mjs';
import { identityHash } from './workload-identity.mjs';

const evidenceSummary = (field, value) => ({
  field,
  canonical_sha256: identityHash(value),
  bytes: Buffer.byteLength(JSON.stringify(value)),
  ...(Array.isArray(value) ? { items: value.length } : {}),
});

const evidenceHashes = (value) => Object.fromEntries(Object.entries(value ?? {}).map(([id, evidence]) => [id, identityHash(evidence)]));

function isPersistedCompactStoreDump(step) {
  if (Object.hasOwn(step, 'stores') || !step.diff || typeof step.diff !== 'object' || Array.isArray(step.diff) || !step.diff.categories || typeof step.diff.categories !== 'object' || Array.isArray(step.diff.categories)) return false;
  const categories = Object.values(step.diff.categories);
  if (!Object.hasOwn(step.diff, 'version')) return categories.every((value) => Number.isSafeInteger(value) && value >= 0);
  return (
    step.diff.version === STORE_DUMP_EVIDENCE_VERSION &&
    categories.every(
      (value) => value && typeof value === 'object' && Number.isSafeInteger(value.count) && value.count >= 0 && /^[0-9a-f]{64}$/.test(value.sha256 ?? '') && Array.isArray(value.representatives) && Number.isSafeInteger(value.omitted) && value.omitted >= 0 && value.omitted === value.count - value.representatives.length
    )
  );
}

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
  if (id === 'store-dump' && isPersistedCompactStoreDump(step)) return JSON.parse(JSON.stringify(step));
  const compact = id === 'retained-quality' ? compactRetainedQuality(step) : id === 'store-dump' ? { ...step } : JSON.parse(JSON.stringify(step));
  const omitted = [];
  const omit = (object, field, label = field) => {
    if (!Object.hasOwn(object, field)) return;
    omitted.push(evidenceSummary(label, object[field]));
    delete object[field];
  };

  if (id === 'store-dump') {
    try {
      const normalized = normalizeStoreDumpEvidence(compact.stores, compact.diff);
      const sourceFormat = normalized.version === STORE_DUMP_EVIDENCE_VERSION ? `v${STORE_DUMP_EVIDENCE_VERSION}` : 'legacy-v1';
      omitted.push({ ...evidenceSummary('stores', normalized.stores), source_format: sourceFormat, representation: `normalized store-dump evidence v${STORE_DUMP_EVIDENCE_VERSION}` });
      omitted.push({ ...evidenceSummary('diff', normalized.diff), source_format: sourceFormat, representation: `normalized store-dump evidence v${STORE_DUMP_EVIDENCE_VERSION}` });
      delete compact.stores;
      compact.diff = { version: STORE_DUMP_EVIDENCE_VERSION, categories: normalized.diff.categories };
    } catch (error) {
      delete compact.stores;
      compact.diff = { unsupported: true, reason: error?.message ?? String(error) };
      omitted.push({ field: 'store-dump', unsupported: true, reason: error?.message ?? String(error) });
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
