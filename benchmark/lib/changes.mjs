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

function packageChange(root, lastTag, paths) {
  if (!paths.includes('package.json')) return null;
  let previous;
  let current;
  try {
    previous = parseJsonObject(git(root, ['show', `${lastTag}:package.json`]));
  } catch {
    return { classification: 'unclassified', changed_fields: [], reason: `package.json at ${lastTag} could not be read and parsed` };
  }
  try {
    current = parseJsonObject(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return { classification: 'unclassified', changed_fields: [], reason: 'working package.json could not be read and parsed' };
  }
  const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter((field) => !isDeepStrictEqual(previous[field], current[field])).sort();
  const dependencyFields = changedFields.filter((field) => DEPENDENCY_FIELDS.has(field));
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

function packageLockChange(root, lastTag, paths) {
  if (!paths.includes('package-lock.json')) return null;
  let previous;
  let current;
  try {
    previous = parseJsonObject(git(root, ['show', `${lastTag}:package-lock.json`]));
  } catch {
    return { classification: 'unclassified', reason: `package-lock.json at ${lastTag} could not be read and parsed` };
  }
  try {
    current = parseJsonObject(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return { classification: 'unclassified', reason: 'working package-lock.json could not be read and parsed' };
  }
  try {
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
  return { lastTag, paths, untracked: [...new Set(untracked)].sort(), packageJson: packageChange(root, lastTag, paths), packageLock: packageLockChange(root, lastTag, paths) };
}
