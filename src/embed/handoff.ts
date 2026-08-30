// Chunk text from reconcile to embed time when both run in one process, so the text is neither
// re-derived nor persisted. Keyed by the store it was stashed against, so an entry dies with it.
const HANDOFF = new WeakMap<object, Map<string, string[]>>();

export function stashChunkText(key: object, texts: Map<string, string[]>): void {
  if (texts.size > 0) HANDOFF.set(key, texts);
}

// Moves an entry from one key to another: reconcile runs before the store object exists, so it
// stashes against the connection and open() re-keys onto the store it then builds.
export function rekeyChunkText(from: object, to: object): void {
  const texts = HANDOFF.get(from);
  if (!texts) return;
  HANDOFF.delete(from);
  HANDOFF.set(to, texts);
}

// Read once and drop: the text is consumed by the embed pass that follows reconcile, and holding
// it past that would pin the tree's prose in memory for the life of the store.
export function takeChunkText(key: object): Map<string, string[]> | undefined {
  const texts = HANDOFF.get(key);
  HANDOFF.delete(key);
  return texts;
}
