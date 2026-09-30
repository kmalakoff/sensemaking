// Published core state has one exact durable signature. Static model identity adoption is a
// preparation transition, not permission for a read snapshot to accept a different signature.
export const CORE_READY_META_KEY = 'core_ready';
export const CORE_GENERATION_META_KEY = 'core_generation';
export const FEATURE_SIGNATURE_META_KEY = 'features';

export function isCoreReady(value: string | null): boolean {
  return value === '1';
}

export function isPublishedFeatureSignature(actual: string | null, expected: string): boolean {
  return actual === expected;
}
