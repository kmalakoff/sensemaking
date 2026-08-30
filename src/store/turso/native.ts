import { loadOrInstall, type NativeDescriptor, packageNodeModules } from '../native.ts';

export const TURSO_PACKAGE = '@tursodatabase/database';

const TURSO: NativeDescriptor = { store: 'turso', pkg: TURSO_PACKAGE, sizeHint: '~16MB' };

let tursoApiPromise: Promise<typeof import('@tursodatabase/database')> | undefined;

// One accessor every consumer must go through, not each its own bare-specifier import: Node
// keeps returning a pre-install "not found" miss to any new lookup of the same path afterward.
export function tursoApi(): Promise<typeof import('@tursodatabase/database')> {
  if (!tursoApiPromise) tursoApiPromise = loadOrInstall<typeof import('@tursodatabase/database')>(TURSO, packageNodeModules());
  return tursoApiPromise;
}
