import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const DEPENDENCY_FIELDS = new Set(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bundledDependencies']);
const NON_RETRIEVAL_PACKAGE_FIELDS = new Set(['scripts', 'version']);

function git(root, argv, maxBuffer = 16e6) {
  const result = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer });
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

const nulPaths = (stdout) => stdout.split('\0').filter(Boolean);

function parseJsonObject(contents) {
  const value = JSON.parse(contents);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON value must be an object');
  return value;
}

function packagePair(root, lastTag) {
  try {
    const previous = parseJsonObject(git(root, ['show', `${lastTag}:package.json`]));
    const current = parseJsonObject(readFileSync(join(root, 'package.json'), 'utf8'));
    return { previous, current };
  } catch (error) {
    return { error: error?.message ?? 'package.json could not be read and parsed' };
  }
}

function lockPair(root, lastTag) {
  try {
    const previous = parseJsonObject(git(root, ['show', `${lastTag}:package-lock.json`]));
    const current = parseJsonObject(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    return { previous, current };
  } catch (error) {
    return { error: error?.message ?? 'package-lock.json could not be read and parsed' };
  }
}

function registryArtifact(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.version !== 'string' || typeof entry.resolved !== 'string' || typeof entry.integrity !== 'string') return false;
  try {
    const url = new URL(entry.resolved);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && url.pathname.endsWith('.tgz') && !Object.hasOwn(entry, 'link');
  } catch {
    return false;
  }
}

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function allowedPinnedRange(specifier, version) {
  return specifier === '*' || specifier === `^${version}` || specifier === `~${version}`;
}

function withoutRootDevDependencies(lock) {
  const packages = { ...lock.packages };
  const root = packages[''];
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  packages[''] = { ...root };
  delete packages[''].devDependencies;
  return { ...lock, packages };
}

function isExactDevDependencyPin(previous, current, locks) {
  if (!locks || locks.error || !locks.previous || !locks.current) return false;
  if (!locks.previous.packages || typeof locks.previous.packages !== 'object' || Array.isArray(locks.previous.packages) || !locks.current.packages || typeof locks.current.packages !== 'object' || Array.isArray(locks.current.packages)) return false;
  const previousDeps = previous.devDependencies;
  const currentDeps = current.devDependencies;
  if (!previousDeps || !currentDeps || typeof previousDeps !== 'object' || typeof currentDeps !== 'object' || Array.isArray(previousDeps) || Array.isArray(currentDeps)) return false;
  const names = [...new Set([...Object.keys(previousDeps), ...Object.keys(currentDeps)])];
  const changed = names.filter((name) => previousDeps[name] !== currentDeps[name]);
  if (changed.length !== 1 || !Object.hasOwn(previousDeps, changed[0]) || !Object.hasOwn(currentDeps, changed[0])) return false;
  const previousRoot = locks.previous.packages?.[''];
  const currentRoot = locks.current.packages?.[''];
  if (
    !previousRoot ||
    !currentRoot ||
    locks.previous.name !== previous.name ||
    locks.current.name !== current.name ||
    locks.previous.version !== previous.version ||
    locks.current.version !== current.version ||
    previousRoot.name !== previous.name ||
    currentRoot.name !== current.name ||
    previousRoot.version !== previous.version ||
    currentRoot.version !== current.version
  )
    return false;
  if (!isDeepStrictEqual(previousRoot.devDependencies, previousDeps) || !isDeepStrictEqual(currentRoot.devDependencies, currentDeps)) return false;
  const previousLock = withoutRootDevDependencies(locks.previous);
  const currentLock = withoutRootDevDependencies(locks.current);
  if (!previousLock || !currentLock || !isDeepStrictEqual(previousLock, currentLock)) return false;
  const previousEntry = locks.previous.packages?.[`node_modules/${changed[0]}`];
  const currentEntry = locks.current.packages?.[`node_modules/${changed[0]}`];
  return EXACT_VERSION.test(currentEntry?.version ?? '') && allowedPinnedRange(previousDeps[changed[0]], currentEntry.version) && registryArtifact(previousEntry) && registryArtifact(currentEntry) && isDeepStrictEqual(previousEntry, currentEntry) && currentDeps[changed[0]] === currentEntry.version;
}

function packageChange(root, lastTag, paths, locks, packageValue) {
  if (!paths.includes('package.json')) return null;
  const pair = packageValue ?? packagePair(root, lastTag);
  if (pair.error) return { classification: 'unclassified', changed_fields: [], reason: pair.error };
  const { previous, current } = pair;
  const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter((field) => !isDeepStrictEqual(previous[field], current[field])).sort();
  const dependencyFields = changedFields.filter((field) => DEPENDENCY_FIELDS.has(field));
  if (changedFields.length === 1 && changedFields[0] === 'devDependencies' && isExactDevDependencyPin(previous, current, locks)) return { classification: 'dev-dependency-pin', changed_fields: changedFields, dependency_fields: ['devDependencies'] };
  if (dependencyFields.length > 0) return { classification: 'dependency', changed_fields: changedFields, dependency_fields: dependencyFields };
  const unclassifiedFields = changedFields.filter((field) => !NON_RETRIEVAL_PACKAGE_FIELDS.has(field));
  if (unclassifiedFields.length > 0) return { classification: 'unclassified', changed_fields: changedFields, reason: `unclassified package fields changed: ${unclassifiedFields.join(', ')}` };
  return { classification: 'version-scripts-only', changed_fields: changedFields };
}

function lockDependencyView(lock) {
  const normalized = { ...lock };
  delete normalized.version;
  if (!Object.hasOwn(lock, 'packages')) return normalized;
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error('lock packages must be an object');
  const packages = { ...lock.packages };
  if (Object.hasOwn(packages, '')) {
    const rootPackage = packages[''];
    if (!rootPackage || typeof rootPackage !== 'object' || Array.isArray(rootPackage)) throw new Error('root lock package must be an object');
    packages[''] = { ...rootPackage };
    delete packages[''].version;
  }
  normalized.packages = packages;
  return normalized;
}

function packageLockChange(_root, _lastTag, paths, locks, packageResult) {
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
export function releaseChanges(root) {
  const lastTag = git(root, ['describe', '--tags', '--abbrev=0']).trim();
  const tracked = nulPaths(git(root, ['diff', '--name-only', '--no-renames', '-z', lastTag]));
  const untracked = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  const paths = [...new Set([...tracked, ...untracked])].sort();
  const packagePairValue = paths.includes('package.json') ? packagePair(root, lastTag) : null;
  const locks = paths.includes('package-lock.json') ? lockPair(root, lastTag) : null;
  const packageJson = packageChange(root, lastTag, paths, locks, packagePairValue);
  return { lastTag, paths, untracked: [...new Set(untracked)].sort(), packageJson, packageLock: packageLockChange(root, lastTag, paths, locks, packageJson) };
}
