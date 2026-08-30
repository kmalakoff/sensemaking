import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeRmSync } from 'fs-remove-compat';

export const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCRATCH_ROOT = join(packageRoot, '.tmp', 'test');
const dirs: string[] = [];
after(() => {
  for (const d of dirs) safeRmSync(d, { recursive: true, force: true });
});

export function scratchDir(prefix: string): string {
  const dir = join(SCRATCH_ROOT, `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}
