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
  /** Optional exact package version required by this native binding. */
  version?: string;
  /** npm specifier used only when installation is required (imports stay bare). */
  installSpec?: string;
}

// install-module-linked is small, but a target native package can be large (@duckdb/node-api's
// ~110MB), so it is required lazily inside the gated branch below, not for every store/index.ts load.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;
const _dirname = dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));

// Walks up from this file's own directory rather than a fixed dot-count: it sits at a
// different depth under src/ than under built dist/{cjs,esm}/store output.
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

// Node caches a bare specifier's resolution, including a "not found" miss, for the process
// lifetime; use the installed entry directly, as a URL for ESM and a path for CJS.
function resolveEntrySpecifier(importName: string, nodeModulesPath: string): string {
  const pkgDir = join(nodeModulesPath, ...importName.split('/'));
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { main?: string; exports?: string };
  const entry = typeof pkg.exports === 'string' ? pkg.exports : (pkg.main ?? 'index.js');
  const entryPath = join(pkgDir, entry);
  return typeof require === 'undefined' ? pathToFileURL(entryPath).href : entryPath;
}

type PackageMetadata = { name?: string; version?: string };

function readPackageMetadata(pkgDir: string): PackageMetadata | undefined {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PackageMetadata;
  } catch {
    return undefined;
  }
}

function targetPackageMetadata(importName: string, nodeModulesPath: string): { exists: boolean; metadata?: PackageMetadata } {
  const pkgDir = join(nodeModulesPath, ...importName.split('/'));
  return { exists: existsSync(pkgDir), metadata: readPackageMetadata(pkgDir) };
}

function resolvedPackageMetadata(importName: string): PackageMetadata | undefined {
  try {
    let dir = dirname(_require.resolve(importName));
    for (;;) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const pkg = readPackageMetadata(dir);
        if (!pkg) return undefined;
        if (pkg.name === importName) return pkg;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function versionContractError(descriptor: NativeDescriptor, installed?: string): SenseError {
  const installSpec = descriptor.installSpec ?? descriptor.pkg;
  const detail = installed ? `${descriptor.pkg}@${installed} is installed` : `${descriptor.pkg} has missing or unreadable version metadata`;
  return new SenseError('STORE_DEPENDENCY_MISSING', `store "${descriptor.store}" needs ${installSpec}, but ${detail}; refusing to overwrite it -- run \`npm install ${installSpec}\` yourself and try again`);
}

function assertExpectedVersion(descriptor: NativeDescriptor, metadata: PackageMetadata | undefined): void {
  if (!descriptor.version) return;
  if (!metadata?.version || metadata.version !== descriptor.version) throw versionContractError(descriptor, metadata?.version);
}

// Import-then-install-then-retry, over an injectable importName so the failure path can be
// exercised in tests without a real native binding. Thrown errors always name descriptor.pkg.
export async function loadOrInstall<T>(descriptor: NativeDescriptor, nodeModulesPath: string, importName: string = descriptor.pkg): Promise<T> {
  if (descriptor.version) {
    const target = targetPackageMetadata(importName, nodeModulesPath);
    if (target.exists) assertExpectedVersion(descriptor, target.metadata);
  }
  let loaded: T;
  try {
    loaded = (await import(importName)) as T;
  } catch {
    const installSpec = descriptor.installSpec ?? importName;
    const displaySpec = descriptor.installSpec ?? descriptor.pkg;
    console.error(`sense: store "${descriptor.store}" needs ${displaySpec}; installing it now (one-time download, ${descriptor.sizeHint})...`);
    try {
      await installOnce(installSpec, nodeModulesPath);
    } catch (installErr) {
      throw new SenseError(
        'STORE_DEPENDENCY_MISSING',
        `store "${descriptor.store}" needs ${displaySpec}, and installing it automatically failed (${(installErr as Error).message}); this can happen offline, in a sandboxed environment, or when node_modules is read-only or owned by another user (e.g. under a global install) -- run \`npm install ${displaySpec}\` yourself and try again`
      );
    }
    try {
      const loaded = (await import(resolveEntrySpecifier(importName, nodeModulesPath))) as T;
      assertExpectedVersion(descriptor, targetPackageMetadata(importName, nodeModulesPath).metadata);
      return loaded;
    } catch (loadErr) {
      throw new SenseError('STORE_DEPENDENCY_MISSING', `store "${descriptor.store}" installed ${displaySpec} but it could not be loaded (${(loadErr as Error).message}); it may not be available for this platform (${process.platform}-${process.arch}) -- run \`npm install ${displaySpec}\` to see the underlying error`);
    }
  }
  if (descriptor.version) assertExpectedVersion(descriptor, resolvedPackageMetadata(importName));
  return loaded;
}
