import { randomUUID } from 'node:crypto';
import { renameSync, unlinkSync, writeFileSync } from 'node:fs';

// Stage-then-swap: write beside the target, then rename over it. A crash or full disk mid-write
// leaves the target untouched instead of truncated. Matches embed/store.ts's model-download idiom.
export function writeFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${randomUUID()}.part`;
  let staged = false;
  try {
    writeFileSync(tmp, data, { flag: 'wx' });
    staged = true;
    renameSync(tmp, path);
  } catch (err) {
    // An exclusive-create collision belongs to another writer; never remove its staging file.
    if (staged || !(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup; the original error below is what matters
      }
    }
    throw err;
  }
}
