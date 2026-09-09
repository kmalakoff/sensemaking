import type { Capability, Config, ResolvedConfig, SenseError } from 'sensemaking';
import { STORE_NAMES, type StoreName } from '../../src/config/types.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from '../../src/store/duckdb/store.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from '../../src/store/sqlite/store.ts';
import { CAPABILITIES as TURSO_CAPABILITIES } from '../../src/store/turso/store.ts';
import { openConfig } from './tree.ts';

// Store-parameterization helpers for cross-store tests: shared fixtures assert documented
// properties directly, with SQLite used as a comparison baseline where needed.
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

type OpenedTree = Awaited<ReturnType<typeof openTreeForStore>>;

export async function withTreeForStore<TResult>(store: ParityStoreName, baseDir: string, fn: (tree: OpenedTree) => Promise<TResult>, extra?: Partial<Config>): Promise<TResult> {
  const tree = await openTreeForStore(store, baseDir, extra);
  try {
    return await fn(tree);
  } finally {
    await tree.store.close();
  }
}

export function isMissingDependency(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as SenseError).code === 'STORE_DEPENDENCY_MISSING';
}

async function runStores<S extends ParityStoreName>(stores: readonly S[], fn: (store: S) => Promise<void>): Promise<void> {
  for (const store of stores) {
    try {
      await fn(store);
    } catch (err) {
      if (err instanceof Error) {
        err.message = `store "${store}": ${err.message}`;
        throw err;
      }
      throw new Error(`store "${store}": ${String(err)}`, { cause: err });
    }
  }
}

// Runs fn once per store, sqlite included. sqlite is a node:sqlite built-in and never throws
// STORE_DEPENDENCY_MISSING; all declared stores are required by the default test and release runs.
export function forEachStore(fn: (store: ParityStoreName) => Promise<void>): Promise<void> {
  return runStores(STORE_NAMES, fn);
}

// Runs fn once per store but sqlite: the shape for tests with an explicit SQLite comparison
// baseline and a separate expectation for every other store.
export function forEachOtherStore(fn: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>): Promise<void> {
  return runStores(OTHER_STORE_NAMES, fn);
}

// Runs fn once per store in the given subset: for a store-restricted case (T6: a function only
// some stores register) rather than the full STORE_NAMES/OTHER_STORE_NAMES sweep.
export function forEachOfStores<S extends ParityStoreName>(stores: readonly S[], fn: (store: S) => Promise<void>): Promise<void> {
  return runStores(stores, fn);
}

// Dispatches per store on whether it declares `capability`: ifSupported runs the real assertion,
// ifMissing where it doesn't. A missing capability is asserted, never skipped (PRINCIPLES: no-silent-modes).
export function forEachStoreByCapability(capability: Capability, ifSupported: (store: ParityStoreName) => Promise<void>, ifMissing: (store: ParityStoreName) => Promise<void>): Promise<void> {
  return runStores(STORE_NAMES, (store) => (hasCapability(store, capability) ? ifSupported(store) : ifMissing(store)));
}

// Same dispatch as forEachStoreByCapability, over every store but the reference.
export function forEachOtherStoreByCapability(capability: Capability, ifSupported: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>, ifMissing: (store: Exclude<ParityStoreName, 'sqlite'>) => Promise<void>): Promise<void> {
  return runStores(OTHER_STORE_NAMES, (store) => (hasCapability(store, capability) ? ifSupported(store) : ifMissing(store)));
}
