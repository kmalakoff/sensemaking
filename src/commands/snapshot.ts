import type { ResolvedConfig } from '../config/index.ts';
import { featureSignature } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { FEATURES } from '../features/index.ts';
import { CORE_READY_META_KEY, FEATURE_SIGNATURE_META_KEY, isCoreReady, isPublishedFeatureSignature } from '../store/readiness.ts';
import type { Store } from '../store/types.ts';

// Read-only policy check for a caller-owned transaction. The store readiness module owns the
// durable keys and compatibility rules; commands only require one published generation before
// reading scope, candidates, graph state, and result details from that same snapshot.
export async function assertQuerySnapshot(store: Store, cfg: ResolvedConfig): Promise<string> {
  const stmt = await store.prepare('SELECT key, value FROM meta WHERE key IN (?, ?)');
  const rows = (await stmt.all(CORE_READY_META_KEY, FEATURE_SIGNATURE_META_KEY)) as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  if (!isCoreReady(values.get(CORE_READY_META_KEY) ?? null)) {
    throw new SenseError('INDEX_NOT_READY', 'the index has no complete published generation; wait for the active build to finish, or run `sense build` (or library build(config)) to recover it');
  }

  const actual = values.get(FEATURE_SIGNATURE_META_KEY) ?? null;
  const expected = featureSignature(cfg, FEATURES);
  if (actual === null || !isPublishedFeatureSignature(actual, expected)) {
    throw new SenseError('INDEX_NOT_READY', 'the published index was built for different configuration features; rebuild it with `sense build` (or library build(config)) before querying');
  }
  return actual;
}
