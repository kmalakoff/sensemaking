import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRmSync } from 'fs-remove-compat';

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCRATCH_ROOT = join(packageRoot, '.tmp', 'test');
const dirs: string[] = [];
after(() => {
  // Per-dir try/catch: one wedged directory (a Windows handle not yet released) would otherwise
  // abort the loop and leave every later dir behind, hiding the leak behind one failure.
  for (const d of dirs) {
    try {
      safeRmSync(d, { recursive: true, force: true });
    } catch (err) {
      console.error(`scratch cleanup failed for ${d}: ${(err as Error).message}`);
    }
  }
});

export function scratchDir(prefix: string): string {
  const dir = join(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
