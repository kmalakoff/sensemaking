import { loadOrInstall, type NativeDescriptor, packageNodeModules } from '../native.ts';

export const DUCKDB_PACKAGE = '@duckdb/node-api';

const DUCKDB: NativeDescriptor = { store: 'duckdb', pkg: DUCKDB_PACKAGE, sizeHint: '~110MB' };

let duckdbApiPromise: Promise<typeof import('@duckdb/node-api')> | undefined;

// The one accessor every consumer of @duckdb/node-api must go through: after a fresh install in this process, Node keeps returning
// the pre-install "not found" miss to any new bare-specifier lookup of the same path, so caching the resolved module here means only the first caller ever resolves it.
export function duckdbApi(): Promise<typeof import('@duckdb/node-api')> {
  if (!duckdbApiPromise) duckdbApiPromise = loadOrInstall<typeof import('@duckdb/node-api')>(DUCKDB, packageNodeModules());
  return duckdbApiPromise;
}
