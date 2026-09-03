// Pure hash of the tree a sitting measures: HEAD, the tracked-content diff, and every untracked
// file's bytes. Content, not filenames or status letters, so two different edits never collide.
import { createHash } from 'node:crypto';

export function treeFingerprint({ head, diff, untracked }) {
  const hash = createHash('sha256').update(head).update('\0').update(diff).update('\0');
  for (const { path, bytes } of untracked) hash.update(path).update('\0').update(bytes).update('\0');
  return hash.digest('hex').slice(0, 8);
}
