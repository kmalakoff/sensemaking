import type { Capability, Config, ResolvedConfig, SenseError } from 'sensemaking';
import { STORE_NAMES, type StoreName } from '../../src/config/types.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from '../../src/store/duckdb/store.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from '../../src/store/sqlite/store.ts';
import { CAPABILITIES as TURSO_CAPABILITIES } from '../../src/store/turso/store.ts';
import { openConfig } from './tree.ts';

// Store-parameterization helpers for cross-store parity tests: the same tree opened under each engine. sqlite is the reference (PRINCIPLES: proven-or-verified); every other store is diffed against it.
// STORE_NAMES comes from src rather than a second list here, so adding a store is one entry there.
export { STORE_NAMES };
export type ParityStoreName = StoreName;

// Every store but the reference.
export const OTHER_STORE_NAMES = STORE_NAMES.filter((store) => store !== 'sqlite') as Exclude<ParityStoreName, 'sqlite'>[];

// Each store's declared capabilities, read from the same constants src/store/index.ts registers
// against, not a second, hand-kept guess. A missing capability is declared behavior (PRINCIPLES: no-silent-modes), so parity cases dispatch on this rather than skip.
const STORE_CAPABILITIES: Record<ParityStoreName, ReadonlySet<Capability>> = {
  sqlite: SQLITE_CAPABILITIES,
  duckdb: DUCKDB_CAPABILITIES,
  turso: TURSO_CAPABILITIES,
};

export function hasCapability(store: ParityStoreName, capability: Capability): boolean {
  return STORE_CAPABILITIES[store].has(capability);
}

// The set a store's own module declares, for the contract case that pins an opened store's
// `capabilities` against it: a store that constructs with a different set is the failure.
export function declaredCapabilities(store: ParityStoreName): ReadonlySet<Capability> {
  return STORE_CAPABILITIES[store];
}

export function openTreeForStore(store: ParityStoreName, baseDir: string, extra?: Partial<Config>) {
  const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, store, ...extra } as ResolvedConfig;
  return openConfig(cfg);
}

export function isMissingDependency(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as SenseError).code === 'STORE_DEPENDENCY_MISSING';
}

async function runSkippingMissing<S extends ParityStoreName>(stores: readonly S[], fn: (store: S) => Promise<void>): Promise<void> {
  for (const store of stores) {
    try {
      await fn(store);
    } catch (err) {
      if (store !== 'sqlite' && isMissingDependency(err)) {
        console.warn(`sense: store "${store}" unavailable (${(err as SenseError).message}); parity case skipped`);
        continue;
      }
      throw err;
    }
  }
}

// Runs fn once per store, sqlite included. sqlite is a node:sqlite built-in and never throws
// STORE_DEPENDENCY_MISSING; a store whose optional native package is missing and cannot be installed is skipped with a warning, not a failure.
export function forEachStore(fn: (store: ParityStoreName) => Promise<void>): Promise<void> {
  return runSkippingMissing(STORE_NAMES, fn);
}

// Runs fn once per store but sqlite: the shape a test uses once it has asserted sqlite's
// result directly and diffs every other store against it. Same skip behavior as forEachStore.
export function forEachOtherStore(fn: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>): Promise<void> {
  return runSkippingMissing(OTHER_STORE_NAMES, fn);
}

// Runs fn once per store in the given subset: for a store-restricted case (T6: a function only
// some stores register) rather than the full STORE_NAMES/OTHER_STORE_NAMES sweep. Same skip behavior as forEachStore.
export function forEachOfStores<S extends ParityStoreName>(stores: readonly S[], fn: (store: S) => Promise<void>): Promise<void> {
  return runSkippingMissing(stores, fn);
}

// Dispatches per store on whether it declares `capability`: ifSupported runs the real assertion,
// ifMissing where it doesn't. A missing capability is asserted, never skipped (PRINCIPLES: no-silent-modes) -- only a genuinely missing optional dependency skips.
export function forEachStoreByCapability(capability: Capability, ifSupported: (store: ParityStoreName) => Promise<void>, ifMissing: (store: ParityStoreName) => Promise<void>): Promise<void> {
  return runSkippingMissing(STORE_NAMES, (store) => (hasCapability(store, capability) ? ifSupported(store) : ifMissing(store)));
}

// Same dispatch as forEachStoreByCapability, over every store but the reference.
export function forEachOtherStoreByCapability(capability: Capability, ifSupported: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>, ifMissing: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>): Promise<void> {
  return runSkippingMissing(OTHER_STORE_NAMES, (store) => (hasCapability(store, capability) ? ifSupported(store) : ifMissing(store)));
}
