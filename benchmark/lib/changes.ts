import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

interface JsonPair {
  previous?: object;
  current?: object;
  error?: unknown;
}
interface PackageChange {
  classification: string;
  changed_fields: string[];
  dependency_fields?: string[];
  reason?: unknown;
}
interface LockChange {
  classification: string;
  reason?: unknown;
}

const DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies']);
const NON_RETRIEVAL_PACKAGE_FIELDS = new Set(['scripts', 'version']);

function git(root: string, argv: string[], maxBuffer = 16e6) {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer });
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const nulPaths = (stdout: string) => stdout.split('\0').filter(Boolean);

function parseJsonObject(contents: string) {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON value must be an object');
  return value;
}

function packagePair(root: string, lastTag: string): JsonPair {
  try {
    const previous = parseJsonObject(git(root, ['show', `${lastTag}:package.json`]));
    const current = parseJsonObject(readFileSync(join(root, 'package.json'), 'utf8'));
    return { previous, current };
  } catch (error) {
    return { error: (error as { message?: unknown } | null | undefined)?.message ?? 'package.json could not be read and parsed' };
  }
}

function lockPair(root: string, lastTag: string): JsonPair {
  try {
    const previous = parseJsonObject(git(root, ['show', `${lastTag}:package-lock.json`]));
    const current = parseJsonObject(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    return { previous, current };
  } catch (error) {
    return { error: (error as { message?: unknown } | null | undefined)?.message ?? 'package-lock.json could not be read and parsed' };
  }
}

function registryArtifact(entry: unknown) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as { version?: unknown }).version !== 'string' || typeof (entry as { resolved?: unknown }).resolved !== 'string' || typeof (entry as { integrity?: unknown }).integrity !== 'string') return false;
  try {
    const url = new URL((entry as { resolved: string }).resolved);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz') && !Object.hasOwn(entry, 'link');
  } catch {
    return false;
  }
}

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function allowedPinnedRange(specifier: unknown, version: unknown) {
  return specifier === '*' || specifier === `^${version}` || specifier === `~${version}`;
}

function withoutRootDevDependencies(lock: object) {
  const packages: Record<string, unknown> = { ...(lock as { packages?: object }).packages };
  const root = packages[''];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  packages[''] = { ...root };
  delete (packages[''] as { devDependencies?: unknown }).devDependencies;
  return { ...lock, packages };
}

function isExactDevDependencyPin(previous: object | undefined, current: object | undefined, locks: JsonPair | null) {
  if (!locks || locks.error || !locks.previous || !locks.current) return false;
  if (
    !(locks.previous as { packages?: unknown }).packages ||
    typeof (locks.previous as { packages?: unknown }).packages !== 'object' ||
    Array.isArray((locks.previous as { packages?: unknown }).packages) ||
    !(locks.current as { packages?: unknown }).packages ||
    typeof (locks.current as { packages?: unknown }).packages !== 'object' ||
    Array.isArray((locks.current as { packages?: unknown }).packages)
  )
    return false;
  const previousDeps = (previous as { devDependencies?: unknown }).devDependencies;
  const currentDeps = (current as { devDependencies?: unknown }).devDependencies;
  if (!previousDeps || !currentDeps || typeof previousDeps !== 'object' || typeof currentDeps !== 'object' || Array.isArray(previousDeps) || Array.isArray(currentDeps)) return false;
  const names = [...new Set([...Object.keys(previousDeps), ...Object.keys(currentDeps)])];
  const changed = names.filter((name) => (previousDeps as Record<string, unknown>)[name] !== (currentDeps as Record<string, unknown>)[name]);
  if (changed.length !== 1 || !Object.hasOwn(previousDeps, changed[0] as string) || !Object.hasOwn(currentDeps, changed[0] as string)) return false;
  const previousRoot = (locks.previous as { packages?: Record<string, unknown> }).packages?.[''];
  const currentRoot = (locks.current as { packages?: Record<string, unknown> }).packages?.[''];
  if (
    !previousRoot ||
    !currentRoot ||
    (locks.previous as { name?: unknown }).name !== (previous as { name?: unknown }).name ||
    (locks.current as { name?: unknown }).name !== (current as { name?: unknown }).name ||
    (locks.previous as { version?: unknown }).version !== (previous as { version?: unknown }).version ||
    (locks.current as { version?: unknown }).version !== (current as { version?: unknown }).version ||
    (previousRoot as { name?: unknown }).name !== (previous as { name?: unknown }).name ||
    (currentRoot as { name?: unknown }).name !== (current as { name?: unknown }).name ||
    (previousRoot as { version?: unknown }).version !== (previous as { version?: unknown }).version ||
    (currentRoot as { version?: unknown }).version !== (current as { version?: unknown }).version
  )
    return false;
  if (!isDeepStrictEqual((previousRoot as { devDependencies?: unknown }).devDependencies, previousDeps) || !isDeepStrictEqual((currentRoot as { devDependencies?: unknown }).devDependencies, currentDeps)) return false;
  const previousLock = withoutRootDevDependencies(locks.previous);
  const currentLock = withoutRootDevDependencies(locks.current);
  if (!previousLock || !currentLock || !isDeepStrictEqual(previousLock, currentLock)) return false;
  const previousEntry = (locks.previous as { packages?: Record<string, unknown> }).packages?.[`node_modules/${changed[0]}`];
  const currentEntry = (locks.current as { packages?: Record<string, unknown> }).packages?.[`node_modules/${changed[0]}`];
  return (
    EXACT_VERSION.test(((currentEntry as { version?: unknown } | null | undefined)?.version ?? '') as string) &&
    allowedPinnedRange((previousDeps as Record<string, unknown>)[changed[0] as string], (currentEntry as { version?: unknown }).version) &&
    registryArtifact(previousEntry) &&
    registryArtifact(currentEntry) &&
    isDeepStrictEqual(previousEntry, currentEntry) &&
    (currentDeps as Record<string, unknown>)[changed[0] as string] === (currentEntry as { version?: unknown }).version
  );
}

function packageChange(root: string, lastTag: string, paths: string[], locks: JsonPair | null, packageValue: JsonPair | null): PackageChange | null {
  if (!paths.includes('package.json')) return null;
  const pair = packageValue ?? packagePair(root, lastTag);
  if (pair.error) return { classification: 'unclassified', changed_fields: [], reason: pair.error };
  const { previous, current } = pair;
  const changedFields = [...new Set([...Object.keys(previous as object), ...Object.keys(current as object)])].filter((field) => !isDeepStrictEqual((previous as Record<string, unknown>)[field], (current as Record<string, unknown>)[field])).sort();
  const dependencyFields = changedFields.filter((field) => DEPENDENCY_FIELDS.has(field));
  if (changedFields.length === 1 && changedFields[0] === 'devDependencies' && isExactDevDependencyPin(previous, current, locks)) return { classification: 'dev-dependency-pin', changed_fields: changedFields, dependency_fields: ['devDependencies'] };
  if (dependencyFields.length > 0) return { classification: 'dependency', changed_fields: changedFields, dependency_fields: dependencyFields };
  const unclassifiedFields = changedFields.filter((field) => !NON_RETRIEVAL_PACKAGE_FIELDS.has(field));
  if (unclassifiedFields.length > 0) return { classification: 'unclassified', changed_fields: changedFields, reason: `unclassified package fields changed: ${unclassifiedFields.join(', ')}` };
  return { classification: 'version-scripts-only', changed_fields: changedFields };
}

function lockDependencyView(lock: object) {
  const normalized: Record<string, unknown> = { ...lock };
  delete normalized.version;
  if (!Object.hasOwn(lock, 'packages')) return normalized;
  if (!(lock as { packages?: unknown }).packages || typeof (lock as { packages?: unknown }).packages !== 'object' || Array.isArray((lock as { packages?: unknown }).packages)) throw new Error('lock packages must be an object');
  const packages: Record<string, unknown> = { ...(lock as { packages?: object }).packages };
  if (Object.hasOwn(packages, '')) {
    const rootPackage = packages[''];
    if (!rootPackage || typeof rootPackage !== 'object' || Array.isArray(rootPackage)) throw new Error('root lock package must be an object');
    packages[''] = { ...rootPackage };
    delete (packages[''] as { version?: unknown }).version;
  }
  normalized.packages = packages;
  return normalized;
}

function packageLockChange(_root: string, _lastTag: string, paths: string[], locks: JsonPair | null, packageResult: PackageChange | null): LockChange | null {
  if (!paths.includes('package-lock.json')) return null;
  if (locks?.error) return { classification: 'unclassified', reason: locks.error };
  const { previous, current } = locks ?? {};
  if (!previous || !current) return { classification: 'unclassified', reason: 'package-lock.json could not be read and parsed' };
  try {
    if (packageResult?.classification === 'dev-dependency-pin') return { classification: 'dev-dependency-pin' };
    return isDeepStrictEqual(lockDependencyView(previous), lockDependencyView(current)) ? { classification: 'version-metadata-only' } : { classification: 'dependency-or-other' };
  } catch {
    return { classification: 'unclassified', reason: 'package-lock.json structure could not be classified' };
  }
}

// --no-renames exposes both the deleted and added sides of a rename. Untracked files are a
// separate Git set and must join the diff because they can ship with the working tree.
export function releaseChanges(root: string) {
  const lastTag = git(root, ['describe', '--tags', '--abbrev=0']).trim();
  const tracked = nulPaths(git(root, ['diff', '--name-only', '--no-renames', '-z', lastTag]));
  const untracked = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const packagePairValue = paths.includes('package.json') ? packagePair(root, lastTag) : null;
  const locks = paths.includes('package-lock.json') ? lockPair(root, lastTag) : null;
  const packageJson = packageChange(root, lastTag, paths, locks, packagePairValue);
  return { lastTag, paths, untracked: [...new Set(untracked)].sort(), packageJson, packageLock: packageLockChange(root, lastTag, paths, locks, packageJson) };
}
