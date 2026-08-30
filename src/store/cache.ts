import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/index.ts';
import { STATE_DIR } from '../config/index.ts';

// Deletes the cache directory and nothing else: the next open() reconciles anyway. Engine-neutral,
// since every store keeps its files under the same STATE_DIR.
export function clearCache(cfg: ResolvedConfig): void {
  rmSync(join(cfg.baseDir, STATE_DIR), { recursive: true, force: true });
}
