// ESM resolves the whole graph before evaluating any of it, so a guard cannot be a static import
// ahead of the one it guards: the caller must run this, then reach the built package dynamically.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertBuilt() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (existsSync(join(root, 'dist', 'esm', 'index.js'))) return;
  console.error('no build found at dist/esm. The gate reads the built package for its store list, so build first:');
  console.error('  npm run benchmark    builds, then gates');
  console.error('  npx tsds build       build alone');
  process.exit(2);
}
