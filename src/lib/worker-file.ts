import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

let packageRoot: string | undefined;

// Workers load emitted CommonJS because a fresh worker thread does not inherit the source TS loader.
// Resolve the package lazily so callers that never spawn a worker do no filesystem work here.
export function resolveWorkerFile(name: string): string {
  if (!packageRoot) {
    const load = createRequire(import.meta.url);
    for (const rel of ['..', '../..', '../../..']) {
      try {
        if ((load(`${rel}/package.json`) as { name?: string }).name === 'sensemaking') {
          packageRoot = dirname(load.resolve(`${rel}/package.json`));
          break;
        }
      } catch {}
    }
  }
  if (!packageRoot) throw new Error(`cannot locate the sensemaking package root, so the ${name} worker cannot be found; run npm run build`);
  return join(packageRoot, 'dist', 'cjs', 'workers', `${name}.js`);
}
