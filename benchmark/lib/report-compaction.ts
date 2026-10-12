import { normalizeStoreDumpEvidence, STORE_DUMP_EVIDENCE_VERSION } from './store-dump-evidence.ts';
import { identityHash } from './workload-identity.ts';

const evidenceSummary = (field: string, value: unknown) => ({
  field,
  canonical_sha256: identityHash(value),
  bytes: Buffer.byteLength(JSON.stringify(value)),
  ...(Array.isArray(value) ? { items: value.length } : {}),
});

const evidenceHashes = (value: unknown) => Object.fromEntries(Object.entries(value ?? {}).map(([id, evidence]: [string, unknown]) => [id, identityHash(evidence)]));

function isPersistedCompactStoreDump(step: object) {
  if (
    Object.hasOwn(step, 'stores') ||
    !(step as { diff?: unknown }).diff ||
    typeof (step as { diff?: unknown }).diff !== 'object' ||
    Array.isArray((step as { diff?: unknown }).diff) ||
    !((step as { diff?: unknown }).diff as { categories?: unknown }).categories ||
    typeof ((step as { diff?: unknown }).diff as { categories?: unknown }).categories !== 'object' ||
    Array.isArray(((step as { diff?: unknown }).diff as { categories?: unknown }).categories)
  )
    return false;
  const categories = Object.values(((step as { diff?: unknown }).diff as { categories: Record<string, unknown> }).categories);
  if (!Object.hasOwn((step as { diff?: unknown }).diff as object, 'version')) return categories.every((value) => Number.isSafeInteger(value) && (value as number) >= 0);
  return (
    ((step as { diff?: unknown }).diff as { version?: unknown }).version === STORE_DUMP_EVIDENCE_VERSION &&
    categories.every(
      (value) =>
        value &&
        typeof value === 'object' &&
        Number.isSafeInteger((value as { count?: unknown }).count) &&
        ((value as { count?: unknown }).count as number) >= 0 &&
        /^[0-9a-f]{64}$/.test(((value as { sha256?: unknown }).sha256 ?? '') as string) &&
        Array.isArray((value as { representatives?: unknown }).representatives) &&
        Number.isSafeInteger((value as { omitted?: unknown }).omitted) &&
        ((value as { omitted?: unknown }).omitted as number) >= 0 &&
        (value as { omitted?: unknown }).omitted === ((value as { count?: unknown }).count as number) - ((value as { representatives?: unknown }).representatives as unknown[]).length
    )
  );
}

export function compactRetainedQuality(record: unknown) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const compact: Record<string, unknown> = { ...record };
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

export function compactStep(id: string, step: unknown): unknown {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
  if (id === 'store-dump' && isPersistedCompactStoreDump(step)) return JSON.parse(JSON.stringify(step));
  const compact: unknown = id === 'retained-quality' ? compactRetainedQuality(step) : id === 'store-dump' ? { ...step } : JSON.parse(JSON.stringify(step));
  const omitted: ({ field: string; canonical_sha256: string; bytes: number; items?: number; source_format?: string; representation?: string } | { field: string; unsupported: boolean; reason: unknown })[] = [];
  const omit = (object: unknown, field: string, label = field) => {
    if (!Object.hasOwn(object as object, field)) return;
    omitted.push(evidenceSummary(label, (object as Record<string, unknown>)[field]));
    delete (object as Record<string, unknown>)[field];
  };

  if (id === 'store-dump') {
    try {
      const normalized = normalizeStoreDumpEvidence((compact as { stores?: unknown }).stores, (compact as { diff?: unknown }).diff);
      const sourceFormat = normalized.version === STORE_DUMP_EVIDENCE_VERSION ? `v${STORE_DUMP_EVIDENCE_VERSION}` : 'legacy-v1';
      omitted.push({ ...evidenceSummary('stores', normalized.stores), source_format: sourceFormat, representation: `normalized store-dump evidence v${STORE_DUMP_EVIDENCE_VERSION}` });
      omitted.push({ ...evidenceSummary('diff', normalized.diff), source_format: sourceFormat, representation: `normalized store-dump evidence v${STORE_DUMP_EVIDENCE_VERSION}` });
      delete (compact as { stores?: unknown }).stores;
      (compact as { diff?: unknown }).diff = { version: STORE_DUMP_EVIDENCE_VERSION, categories: normalized.diff.categories };
    } catch (error) {
      delete (compact as { stores?: unknown }).stores;
      (compact as { diff?: unknown }).diff = { unsupported: true, reason: (error as { message?: unknown } | null | undefined)?.message ?? String(error) };
      omitted.push({ field: 'store-dump', unsupported: true, reason: (error as { message?: unknown } | null | undefined)?.message ?? String(error) });
    }
  }
  for (const field of ['query_evidence', 'qrels']) omit(compact, field);
  for (const [name, variant] of Object.entries((compact as { variants?: unknown }).variants ?? {})) {
    if (variant && typeof variant === 'object') omit(variant, 'per_query', `variants.${name}.per_query`);
  }
  return omitted.length === 0
    ? compact
    : {
        ...(compact as object),
        omitted_evidence: {
          retention: 'Raw evidence is retained only in the named sitting. This compact release record cannot revalidate omitted evidence.',
          fields: omitted,
        },
      };
}
