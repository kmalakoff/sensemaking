import { existsSync, readFileSync } from 'node:fs';
import Module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import semver from 'semver';
import { SenseError } from '../errors.ts';

// A store's optional native package, and the strings its error messages and install notice name.
export interface NativeDescriptor {
  store: string;
  pkg: string;
  sizeHint: string;
  /** The tested semver range: sensemaking's own `peerDependencies` entry for `pkg` (see `peerRange`). */
  range: string;
}

// A loaded native package and the version that actually resolved, which the store's engine identity records.
export interface NativeModule<T> {
  api: T;
  version: string | undefined;
}

// install-module-linked is small, but a target native package can be large (@duckdb/node-api's
// ~110MB), so it is required lazily inside the gated branch below, not for every store/index.ts load.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;
const _dirname = dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

type PackageMetadata = { name?: string; version?: string; peerDependencies?: Record<string, string> };

// Walks up from this file's own directory rather than a fixed dot-count: it sits at a
// different depth under src/ than under built dist/{cjs,esm}/store output.
function packageRoot(): { dir: string; manifest: PackageMetadata } {
  let dir = _dirname;
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as PackageMetadata;
      if (manifest.name === 'sensemaking') return { dir, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the sensemaking package root to install a native dependency into');
    dir = parent;
  }
}

export function packageNodeModules(): string {
  return join(packageRoot().dir, 'node_modules');
}

// The published contract for an optional native package: the range it is tested against.
export function peerRange(pkg: string): string {
  const range = packageRoot().manifest.peerDependencies?.[pkg];
  if (!range) throw new Error(`sensemaking's package.json declares no peerDependencies entry for ${pkg}`);
  return range;
}

const installing = new Map<string, Promise<void>>();

// De-dupes concurrent installs: since the install is async, concurrent callers await the same
// in-flight promise, keyed by specifier and target. A failed install is not cached, so a later call retries.
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

function readPackageMetadata(pkgDir: string): PackageMetadata | undefined {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PackageMetadata;
  } catch {
    return undefined;
  }
}

// Node caches a bare specifier's resolution, including a "not found" miss, for the process
// lifetime; use the installed entry directly, as a URL for ESM and a path for CJS.
function resolveEntrySpecifier(importName: string, nodeModulesPath: string): string {
  const pkgDir = join(nodeModulesPath, ...importName.split('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { main?: string; exports?: string };
  const entry = typeof pkg.exports === 'string' ? pkg.exports : (pkg.main ?? 'index.js');
  const entryPath = join(pkgDir, entry);
  return typeof require === 'undefined' ? pathToFileURL(entryPath).href : entryPath;
}

function resolvedVersion(importName: string): string | undefined {
  try {
    let dir = dirname(_require.resolve(importName));
    for (;;) {
      const pkg = readPackageMetadata(dir);
      if (pkg?.name === importName) return pkg.version;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

// Any installed version is used; one outside the tested range is reported, not refused (the store's engine check decides).
function reportVersion(descriptor: NativeDescriptor, version: string | undefined): void {
  if (version && semver.satisfies(version, descriptor.range)) return;
  console.error(`sense: store "${descriptor.store}" using ${descriptor.pkg}@${version ?? 'unknown version'} (tested ${descriptor.range})`);
}

// Import-then-install-then-retry, over an injectable importName so the failure path can be
// exercised in tests without a real native binding. Thrown errors always name descriptor.pkg.
export async function loadOrInstall<T>(descriptor: NativeDescriptor, nodeModulesPath: string, importName: string = descriptor.pkg): Promise<NativeModule<T>> {
  try {
    const api = (await import(importName)) as T;
    const version = resolvedVersion(importName);
    reportVersion(descriptor, version);
    return { api, version };
  } catch {
    // Not resolvable here: install the newest version npm would pick for the tested range.
  }
  const spec = `${descriptor.pkg}@${descriptor.range}`;
  const installSpec = `${importName}@${descriptor.range}`;
  console.error(`sense: store "${descriptor.store}" needs ${spec}; installing it now (one-time download, ${descriptor.sizeHint})...`);
  try {
    await installOnce(installSpec, nodeModulesPath);
  } catch (installErr) {
    throw new SenseError(
      'STORE_DEPENDENCY_MISSING',
      `store "${descriptor.store}" needs ${spec}, and installing it automatically failed (${(installErr as Error).message}); this can happen offline, in a sandboxed environment, or when node_modules is read-only or owned by another user (e.g. under a global install) -- run \`npm install ${spec}\` yourself and try again`
    );
  }
  try {
    const api = (await import(resolveEntrySpecifier(importName, nodeModulesPath))) as T;
    const version = readPackageMetadata(join(nodeModulesPath, ...importName.split('/')))?.version;
    reportVersion(descriptor, version);
    return { api, version };
  } catch (loadErr) {
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "${descriptor.store}" installed ${spec} but it could not be loaded (${(loadErr as Error).message}); it may not be available for this platform (${process.platform}-${process.arch}) -- run \`npm install ${spec}\` to see the underlying error`);
  }
}
