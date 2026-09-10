// Benchmark workload identity keeps logical inputs, copied state, and implementation provenance
// separate. These hashes prove identity only; authored fixtures remain the correctness oracle.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from './canonical-json.mjs';

function validateNumbers(value, path = '$') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`identity input ${path} is non-finite`);
  if (Array.isArray(value)) value.forEach((item, index) => validateNumbers(item, `${path}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) validateNumbers(item, `${path}.${key}`);
}

function persistedValue(value) {
  validateNumbers(value);
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('identity input is not JSON-persistable');
  return JSON.parse(json);
}

export const identityHash = (value) =>
  createHash('sha256')
    .update(canonicalJson(persistedValue(value)))
    .digest('hex');

export function manifestIdentity(manifest, { includeMtime = false } = {}) {
  const files = manifest.map((file) => ({ path: file.rel, bytes: file.bytes, sha256: file.sha256, ...(includeMtime ? { mtime_ms: file.mtimeMs } : {}) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0), paths_fingerprint: identityHash(files.map((file) => file.path)), fingerprint: identityHash(files) };
}

/** @param {{ corpus: unknown, operation: unknown, requested: unknown, observableState?: unknown }} value */
export function logicalWorkloadIdentity({ corpus, operation, requested, observableState }) {
  const inputs = persistedValue({ corpus, operation, requested, ...(observableState ? { observable_state: observableState } : {}) });
  return { fingerprint: identityHash(inputs), inputs };
}

const sensitiveKey = (key) => key === 'url' || /(?:key|token|secret|password)$/i.test(key);

function safeConfig(value, key = '') {
  if (sensitiveKey(key) && value !== null && value !== undefined) return { redacted_sha256: identityHash(value) };
  if (Array.isArray(value)) return value.map((item) => safeConfig(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, safeConfig(item, childKey)]));
  return value;
}

export function executionEvidence({ argv, config, resolvedEquivalence = 'unverified' }) {
  const safe = persistedValue(safeConfig(config));
  return { argv: persistedValue(argv), config_fingerprint: identityHash(safe), config: safe, resolved_equivalence: resolvedEquivalence };
}

export function logicalConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const { baseDir: _baseDir, configPath: _configPath, rootDir: _rootDir, configDir: _configDir, store: _store, ...logical } = config;
  return logical;
}

function fileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root, dir = root) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`provenance path is a symlink: ${path}`);
    if (entry.isDirectory()) out.push(...walkFiles(root, path));
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join('/'));
  }
  return out;
}

export function pathSetIdentity(root, paths) {
  const absoluteRoot = resolve(root);
  const files = [];
  for (const rel of [...paths].sort()) {
    const path = resolve(absoluteRoot, rel);
    if (path !== absoluteRoot && !path.startsWith(`${absoluteRoot}${sep}`)) throw new Error(`provenance path escapes root: ${rel}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`provenance path is not a regular file: ${path}`);
    files.push({ path: rel.split(sep).join('/'), bytes: stat.size, sha256: fileHash(path) });
  }
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0), fingerprint: identityHash(files) };
}

export function directoryIdentity(path) {
  if (!existsSync(path)) return { status: 'absent' };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`provenance path is not a regular directory: ${path}`);
  return { status: 'recorded', ...pathSetIdentity(path, walkFiles(path)) };
}

export function installedPackageVersion(packageRoot, name) {
  try {
    const require = createRequire(join(packageRoot, 'package.json'));
    let entry = require.resolve(name);
    while (dirname(entry) !== entry) {
      entry = dirname(entry);
      const packageJson = join(entry, 'package.json');
      if (!existsSync(packageJson)) continue;
      const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
      if (pkg.name === name && typeof pkg.version === 'string') return pkg.version;
    }
  } catch {
    // Optional native packages may be installed on first use outside this package root.
  }
  return 'unknown';
}

export function implementationProvenance({ packageRoot, harnessRoot, harnessFiles, store, nativeObservation, modelObservation }) {
  const packageJsonPath = join(packageRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const nativePackage = store === 'duckdb' ? '@duckdb/node-api' : store === 'turso' ? '@tursodatabase/database' : null;
  return {
    measured_package: {
      name: pkg.name ?? null,
      version: pkg.version ?? null,
      package_json: pathSetIdentity(packageRoot, ['package.json']),
      source: directoryIdentity(join(packageRoot, 'src')),
      dist: directoryIdentity(join(packageRoot, 'dist')),
    },
    harness: { paths: [...harnessFiles].sort(), ...pathSetIdentity(harnessRoot, harnessFiles) },
    runtime: { node: process.version },
    native: {
      store,
      package: nativePackage ? { name: nativePackage, version: installedPackageVersion(packageRoot, nativePackage) } : null,
      observation: nativeObservation,
    },
    model: modelObservation,
  };
}
