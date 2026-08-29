// Wraps an async interval tick so a rejection (e.g. a store closed mid-await) never
// escapes as an unhandled rejection, and so a skip() guard can suppress the call entirely.
export function guardedTick(fn: () => Promise<void>, skip: () => boolean): () => void {
  return () => {
    if (skip()) return;
    fn().catch(() => {});
  };
}
