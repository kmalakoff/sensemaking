import { loadOrInstall, type NativeDescriptor, type NativeModule, packageNodeModules, peerRange } from '../native.ts';

export const TURSO_PACKAGE = '@tursodatabase/database';

// Every connect() in this store goes through these: the same 30s floor sqlite opens with, and the
// FTS index method ensureSchema() needs. reclaimSpace adds 'vacuum'; nothing else may (PLAN 3.54).
export const CONNECT_OPTS = { timeout: 30_000, experimental: ['index_method'] } as const;

type TursoApi = typeof import('@tursodatabase/database');

let tursoNativePromise: Promise<NativeModule<TursoApi>> | undefined;

// One accessor every consumer must go through, not each its own bare-specifier import: Node
// keeps returning a pre-install "not found" miss to any new lookup of the same path afterward.
export function tursoNative(): Promise<NativeModule<TursoApi>> {
  if (!tursoNativePromise) {
    const descriptor: NativeDescriptor = { store: 'turso', pkg: TURSO_PACKAGE, sizeHint: '~16MB', range: peerRange(TURSO_PACKAGE) };
    tursoNativePromise = loadOrInstall<TursoApi>(descriptor, packageNodeModules());
  }
  return tursoNativePromise;
}

export async function tursoApi(): Promise<TursoApi> {
  return (await tursoNative()).api;
}
