import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

// Stage-then-swap: write beside the target, then rename over it. A crash or full disk mid-write
// leaves the target untouched instead of truncated. Matches embed/store.ts's model-download idiom.
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.part`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; the rename error below is what matters
    }
    throw err;
  }
}
