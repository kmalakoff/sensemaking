import { loadOrInstall, type NativeDescriptor, type NativeModule, packageNodeModules, peerRange } from '../native.ts';

export const DUCKDB_PACKAGE = '@duckdb/node-api';

type DuckdbApi = typeof import('@duckdb/node-api');

let duckdbNativePromise: Promise<NativeModule<DuckdbApi>> | undefined;

// The one accessor every consumer of @duckdb/node-api must go through: after a fresh install in this process, Node keeps returning
// the pre-install "not found" miss to any new bare-specifier lookup of the same path, so caching the resolved module here means only the first caller ever resolves it.
export function duckdbNative(): Promise<NativeModule<DuckdbApi>> {
  if (!duckdbNativePromise) {
    const descriptor: NativeDescriptor = { store: 'duckdb', pkg: DUCKDB_PACKAGE, sizeHint: '~110MB', range: peerRange(DUCKDB_PACKAGE) };
    duckdbNativePromise = loadOrInstall<DuckdbApi>(descriptor, packageNodeModules());
  }
  return duckdbNativePromise;
}

export async function duckdbApi(): Promise<DuckdbApi> {
  return (await duckdbNative()).api;
}
