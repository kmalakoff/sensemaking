import { loadOrInstall, type NativeDescriptor, packageNodeModules } from '../native.ts';

export const DUCKDB_PACKAGE = '@duckdb/node-api';

const DUCKDB: NativeDescriptor = { store: 'duckdb', pkg: DUCKDB_PACKAGE, sizeHint: '~110MB' };

let duckdbApiPromise: Promise<typeof import('@duckdb/node-api')> | undefined;

// The one accessor every consumer of @duckdb/node-api (open.ts, sql-functions.ts, vectors.ts)
// must go through, rather than each doing its own `import('@duckdb/node-api')`: once a fresh
// install has happened in this process, Node keeps returning that pre-install "not found" miss
// to any NEW bare-specifier lookup of the same path, so a second independent import elsewhere
// in the process fails even though the package is now genuinely on disk (the same stale-cache
// problem loadOrInstall works around for its own retry). Caching the resolved module here means
// only the first caller ever resolves the bare specifier at all.
export function duckdbApi(): Promise<typeof import('@duckdb/node-api')> {
  if (!duckdbApiPromise) duckdbApiPromise = loadOrInstall<typeof import('@duckdb/node-api')>(DUCKDB, packageNodeModules());
  return duckdbApiPromise;
}
