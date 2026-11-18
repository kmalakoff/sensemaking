import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Only write site for the harness's sense.config.json files. Store is a run-time fact, not a
// build fact: cache entries are shared across stores, so the key is set only when a run names one.
export function writeTreeConfig(tree: string, config: object, { store }: { store?: string } = {}) {
  if (store) config = { ...config, store };
  writeFileSync(join(tree, 'sense.config.json'), JSON.stringify(config));
}
