import { loadOrInstall, type NativeDescriptor, packageNodeModules } from '../native.ts';

export const TURSO_PACKAGE = '@tursodatabase/database';

const TURSO: NativeDescriptor = { store: 'turso', pkg: TURSO_PACKAGE, sizeHint: '~16MB' };

let tursoApiPromise: Promise<typeof import('@tursodatabase/database')> | undefined;

// The one accessor every consumer of @tursodatabase/database (open.ts) must go through, rather
// than each doing its own `import('@tursodatabase/database')`: once a fresh install has happened
// in this process, Node keeps returning that pre-install "not found" miss to any NEW
// bare-specifier lookup of the same path, so a second independent import elsewhere in the
// process fails even though the package is now genuinely on disk (the same stale-cache problem
// loadOrInstall works around for its own retry). Caching the resolved module here means only the
// first caller ever resolves the bare specifier at all.
export function tursoApi(): Promise<typeof import('@tursodatabase/database')> {
  if (!tursoApiPromise) tursoApiPromise = loadOrInstall<typeof import('@tursodatabase/database')>(TURSO, packageNodeModules());
  return tursoApiPromise;
}
