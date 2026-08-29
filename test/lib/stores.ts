import type { Config, ResolvedConfig } from 'sensemaking';
import { openConfig } from './tree.ts';

// Store-parameterization helper for cross-store parity tests: the same tree, opened under
// each engine in turn. sqlite is the reference implementation (principle 1); duckdb is
// diffed against it.
export const STORE_NAMES = ['sqlite', 'duckdb'] as const;
export type ParityStoreName = (typeof STORE_NAMES)[number];

export function openTreeForStore(store: ParityStoreName, baseDir: string, extra?: Partial<Config>) {
  const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, store, ...extra } as ResolvedConfig;
  return openConfig(cfg);
}
