import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SenseError } from '../../errors.ts';

export const DUCKDB_PACKAGE = '@duckdb/node-api';

// install-module-linked itself is small, but its target (@duckdb/node-api) is not: deferred the
// same way embed/static.ts defers @huggingface/tokenizers, so requiring it stays inside the
// already-gated branch below rather than running for every store/index.ts load.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;
const _dirname = dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

// Walks up from this file's own directory to find the real package.json, rather than a fixed
// dot-count from __dirname (xz-compat's `../../node_modules`): `tsds test:node` runs straight
// off src/, one directory shallower than dist/{cjs,esm}/store/duckdb sits under the built
// package, so a hardcoded depth is right for one and wrong for the other. Works the same way
// for a globally-installed `sense`, whose node_modules this resolves to -- never the caller's
// cwd.
function packageNodeModules(): string {
  let dir = _dirname;
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === 'sensemaking') return join(dir, 'node_modules');
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the sensemaking package root to install @duckdb/node-api into');
    dir = parent;
  }
}

const installing = new Map<string, Promise<void>>();

// De-dupes concurrent installs within this process (see spawn-term's loadInk for the shape).
// The install here is async -- the load site already awaits a dynamic import -- so a bare
// attempted flag (xz-compat's `installationAttempted`, enough for its synchronous single-target
// install) isn't enough on its own; concurrent callers instead await the same in-flight promise,
// keyed by specifier and target so tests exercising several installs in one process don't share
// one slot. A failed install is not cached, so a later call retries.
function installOnce(specifier: string, nodeModulesPath: string): Promise<void> {
  const key = `${specifier}\n${nodeModulesPath}`;
  let promise = installing.get(key);
  if (!promise) {
    const installModuleLinked = (_require('install-module-linked') as { default: (specifier: string, nodeModulesPath: string) => Promise<string> }).default;
    promise = installModuleLinked(specifier, nodeModulesPath).then(
      () => {},
      (err) => {
        installing.delete(key);
        throw err;
      }
    );
    installing.set(key, promise);
  }
  return promise;
}

// Node caches a bare specifier's package resolution -- including a "not found" miss -- for the
// life of the process, so retrying `import(importName)` right after installing sees the same
// stale miss and falls through to a bogus index.js guess instead of the package's real entry
// (verified against a real global install: the plain-specifier retry failed there, this did
// not). Reading the freshly-installed package's own package.json and importing its entry file
// by an absolute file: URL sidesteps that stale cache instead of re-resolving the bare name.
function resolveEntryUrl(importName: string, nodeModulesPath: string): string {
  const pkgDir = join(nodeModulesPath, ...importName.split('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { main?: string; exports?: string };
  const entry = typeof pkg.exports === 'string' ? pkg.exports : (pkg.main ?? 'index.js');
  return pathToFileURL(join(pkgDir, entry)).href;
}

// Import-then-install-then-retry, over an injectable target so the failure path (import AND
// install both fail) can be exercised for real in tests without downloading @duckdb/node-api's
// real ~110MB native binding. Production always passes @duckdb/node-api's own name; the thrown
// error names @duckdb/node-api regardless, since that is what a real user needs to install.
export async function loadOrInstall<T>(importName: string, nodeModulesPath: string): Promise<T> {
  try {
    return (await import(importName)) as T;
  } catch {
    console.error(`sense: store "duckdb" needs ${DUCKDB_PACKAGE}; installing it now (one-time download, ~110MB)...`);
    try {
      await installOnce(importName, nodeModulesPath);
    } catch (installErr) {
      throw new SenseError(
        'STORE_DEPENDENCY_MISSING',
        `store "duckdb" needs ${DUCKDB_PACKAGE}, and installing it automatically failed (${(installErr as Error).message}); this can happen offline, in a sandboxed environment, or when node_modules is read-only or owned by another user (e.g. under a global install) -- run \`npm install ${DUCKDB_PACKAGE}\` yourself and try again`
      );
    }
    try {
      return (await import(resolveEntryUrl(importName, nodeModulesPath))) as T;
    } catch (loadErr) {
      throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" installed ${DUCKDB_PACKAGE} but it could not be loaded (${(loadErr as Error).message}); it may not be available for this platform (${process.platform}-${process.arch}) -- run \`npm install ${DUCKDB_PACKAGE}\` to see the underlying error`);
    }
  }
}

let duckdbApiPromise: Promise<typeof import('@duckdb/node-api')> | undefined;

// The one accessor every consumer of @duckdb/node-api (open.ts, sql-functions.ts, vectors.ts)
// must go through, rather than each doing its own `import('@duckdb/node-api')`: once a fresh
// install has happened in this process, Node keeps returning that pre-install "not found" miss
// to any NEW bare-specifier lookup of the same path, so a second independent import elsewhere
// in the process fails even though the package is now genuinely on disk (the same stale-cache
// problem loadOrInstall works around for its own retry). Caching the resolved module here means
// only the first caller ever resolves the bare specifier at all.
export function duckdbApi(): Promise<typeof import('@duckdb/node-api')> {
  if (!duckdbApiPromise) duckdbApiPromise = loadOrInstall<typeof import('@duckdb/node-api')>(DUCKDB_PACKAGE, packageNodeModules());
  return duckdbApiPromise;
}
