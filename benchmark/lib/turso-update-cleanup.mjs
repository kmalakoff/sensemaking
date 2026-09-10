import { existsSync } from 'node:fs';
import { safeRmSync } from 'fs-remove-compat';

export function combinedError(primary, cleanup) {
  if (primary && cleanup) return new AggregateError([primary, cleanup], 'operation and cleanup failed');
  return primary ?? cleanup;
}

// A failed close can leave a native handle live. Retry once before permitting scratch cleanup.
export async function closeForCleanup(handle, close) {
  if (!handle) return { released: true, error: null };
  try {
    await close(handle);
    return { released: true, error: null };
  } catch (firstError) {
    try {
      await close(handle);
      return { released: true, error: null };
    } catch (retryError) {
      return {
        released: false,
        error: new AggregateError([firstError, retryError], 'resource close failed'),
      };
    }
  }
}

export function cleanupTemporaryTree(tree, released) {
  if (!released) return new Error(`temporary tree retained because its native resource could not be closed: ${tree}`);
  try {
    safeRmSync(tree, { recursive: true, force: true });
    if (existsSync(tree)) return new Error(`cleanup left temporary tree: ${tree}`);
    return null;
  } catch (error) {
    return error;
  }
}
