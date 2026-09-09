import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRmSync } from 'fs-remove-compat';

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCRATCH_ROOT = join(packageRoot, '.tmp', 'test');
const dirs: string[] = [];
export function cleanupScratchDirs(paths: readonly string[] = dirs): void {
  const errors: unknown[] = [];
  for (const d of paths) {
    try {
      safeRmSync(d, { recursive: true, force: true });
      if (existsSync(d)) errors.push(new Error(`scratch cleanup left path: ${d}`));
    } catch (err) {
      errors.push(new Error(`scratch cleanup failed for ${d}: ${(err as Error).message}`, { cause: err }));
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `scratch cleanup failed for ${errors.length} path(s)`);
}

after(() => cleanupScratchDirs());

export function scratchDir(prefix: string): string {
  const dir = join(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
