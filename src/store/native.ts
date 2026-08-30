import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SenseError } from '../errors.ts';

// A store's optional native package, and the strings its error messages and install notice name.
export interface NativeDescriptor {
  store: string;
  pkg: string;
  sizeHint: string;
}

// install-module-linked itself is small, but a target native package can be large (@duckdb/node-
// api's ~110MB is the current instance): deferred the same way embed/static.ts defers
// @huggingface/tokenizers, so requiring it stays inside the already-gated branch below rather
// than running for every store/index.ts load.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;
const _dirname = dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

// Walks up from this file's own directory to find the real package.json, rather than a fixed
// dot-count from __dirname (xz-compat's `../../node_modules`): this file sits at a different
// depth under src/ during `tsds test:node` than under the built dist/{cjs,esm}/store output, so a
// hardcoded depth is right for one and wrong for the other. Works the same way for a
// globally-installed `sense`, whose node_modules this resolves to -- never the caller's cwd.
export function packageNodeModules(): string {
  let dir = _dirname;
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === 'sensemaking') return join(dir, 'node_modules');
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the sensemaking package root to install a native dependency into');
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

// Import-then-install-then-retry, over an injectable importName so the failure path (import AND
// install both fail) can be exercised for real in tests without downloading a real store's native
// binding. importName defaults to descriptor.pkg, which is what production always wants; the
// thrown errors name descriptor.pkg regardless, since that is what a real user needs to install.
export async function loadOrInstall<T>(descriptor: NativeDescriptor, nodeModulesPath: string, importName: string = descriptor.pkg): Promise<T> {
  try {
    return (await import(importName)) as T;
  } catch {
    console.error(`sense: store "${descriptor.store}" needs ${descriptor.pkg}; installing it now (one-time download, ${descriptor.sizeHint})...`);
    try {
      await installOnce(importName, nodeModulesPath);
    } catch (installErr) {
      throw new SenseError(
        'STORE_DEPENDENCY_MISSING',
        `store "${descriptor.store}" needs ${descriptor.pkg}, and installing it automatically failed (${(installErr as Error).message}); this can happen offline, in a sandboxed environment, or when node_modules is read-only or owned by another user (e.g. under a global install) -- run \`npm install ${descriptor.pkg}\` yourself and try again`
      );
    }
    try {
      return (await import(resolveEntryUrl(importName, nodeModulesPath))) as T;
    } catch (loadErr) {
      throw new SenseError(
        'STORE_DEPENDENCY_MISSING',
        `store "${descriptor.store}" installed ${descriptor.pkg} but it could not be loaded (${(loadErr as Error).message}); it may not be available for this platform (${process.platform}-${process.arch}) -- run \`npm install ${descriptor.pkg}\` to see the underlying error`
      );
    }
  }
}
