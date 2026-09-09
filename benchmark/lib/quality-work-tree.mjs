import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeRmSync } from 'fs-remove-compat';
import { captureFileManifest, ephemeralWorkTree, verifyFileManifest, verifyManifestContents } from './work-tree.mjs';
import { identityHash, manifestIdentity } from './workload-identity.mjs';

const MARKER = '.quality-cache.json';

const fileIdentity = (path) => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`quality model path is not a regular file: ${path}`);
  return { bytes: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

export async function observeQualityModel(packageRoot, embed) {
  if (embed.provider !== 'static') return { provider: embed.provider, model: embed.model, revision: 'unknown', reuse_eligible: false };
  const moduleUrl = pathToFileURL(join(packageRoot, 'dist', 'esm', 'embed', 'identity.js')).href;
  const identity = await import(moduleUrl);
  const dir = identity.modelDir(embed.model);
  const ref = identity.isDownloadable(embed.model) ? (identity.readRef(embed.model) ?? null) : null;
  try {
    const files = Object.fromEntries(identity.MODEL_FILES.map((name) => [name, fileIdentity(join(dir, name))]));
    return { provider: 'static', model: embed.model, ref, files, fingerprint: identityHash(files), reuse_eligible: true };
  } catch (err) {
    return { provider: 'static', model: embed.model, ref, status: 'unknown', error: err?.message ?? String(err), reuse_eligible: false };
  }
}

function assertTree(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`quality cache path is not a regular directory: ${path}`);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`quality cache contains a symlink: ${child}`);
    if (entry.isDirectory()) assertTree(child);
  }
}

function treeManifest(root) {
  if (!existsSync(root)) return [];
  assertTree(root);
  function walk(dir) {
    const files = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(path));
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), ...fileIdentity(path) });
    }
    return files;
  }
  return walk(root);
}

function readMarker(dir, expectedFingerprint) {
  const path = join(dir, MARKER);
  let marker;
  try {
    marker = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`quality cache has an invalid completion marker at ${path}: ${err?.message ?? err}`);
  }
  if (marker?.version !== 1 || typeof marker.cache_fingerprint !== 'string') throw new Error(`quality cache has a malformed completion marker at ${path}: invalid identity fields`);
  if (marker.cache_fingerprint !== expectedFingerprint) return null;
  try {
    if (identityHash(marker.cache_inputs) !== marker.cache_fingerprint || !Array.isArray(marker.copied_manifest) || !Array.isArray(marker.sense_manifest) || marker.sense_manifest.length === 0 || !existsSync(join(dir, '.sense'))) throw new Error('invalid fields');
  } catch (err) {
    throw new Error(`quality cache has a malformed completion marker at ${path}: ${err?.message ?? err}`);
  }
  verifyFileManifest(dir, marker.copied_manifest, 'completed quality cache corpus');
  if (identityHash(treeManifest(join(dir, '.sense'))) !== identityHash(marker.sense_manifest)) throw new Error(`completed quality cache native files changed: ${dir}`);
  return marker;
}

function completedGenerations(root) {
  if (!existsSync(root)) return [];
  const generations = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`quality cache completed entry is not a regular directory: ${join(root, entry.name)}`);
    generations.push(join(root, entry.name));
  }
  return generations.sort();
}

export function prepareQualityWorkTree({ workRoot, key, source, cacheInputs, reuseEligible }) {
  if (typeof key !== 'string' || key.length === 0 || key === '.' || key === '..' || key.includes('/') || key.includes('\\')) throw new Error(`invalid quality cache key ${JSON.stringify(key)}`);
  const sourceManifest = captureFileManifest(source);
  const inputs = { ...cacheInputs, source: manifestIdentity(sourceManifest, { includeMtime: true }) };
  const cacheFingerprint = identityHash(inputs);
  const completedRoot = join(workRoot, key, 'completed');
  let reused = null;
  let reusedMarker = null;
  if (reuseEligible) {
    for (const dir of completedGenerations(completedRoot)) {
      const marker = readMarker(dir, cacheFingerprint);
      if (marker) {
        reused = dir;
        reusedMarker = marker;
      }
    }
  }

  const tree = ephemeralWorkTree(join(workRoot, key), '.run-', source);
  let copiedManifest;
  try {
    copiedManifest = captureFileManifest(tree);
    verifyManifestContents(copiedManifest, sourceManifest, 'quality run corpus');
    verifyFileManifest(source, sourceManifest, 'quality source before run');
    if (reused && existsSync(join(reused, '.sense'))) {
      if (!reusedMarker) throw new Error(`quality cache lost its completion evidence: ${reused}`);
      cpSync(join(reused, '.sense'), join(tree, '.sense'), { recursive: true, preserveTimestamps: true });
      if (identityHash(treeManifest(join(tree, '.sense'))) !== identityHash(reusedMarker.sense_manifest)) throw new Error(`quality run received a changed native cache copy: ${reused}`);
    }
  } catch (primary) {
    let cleanupError = null;
    try {
      safeRmSync(tree, { recursive: true, force: true });
    } catch (cleanup) {
      cleanupError = cleanup;
    }
    if (existsSync(tree)) cleanupError = new Error(`quality work tree preparation left staging path: ${tree}`, { cause: cleanupError });
    if (cleanupError) throw new AggregateError([primary, cleanupError], 'quality work tree preparation and cleanup failed');
    throw primary;
  }

  let settled = false;
  /** @param {unknown} [primary] */
  const discard = (primary = null) => {
    if (settled) {
      if (primary) throw primary;
      return;
    }
    settled = true;
    const errors = primary ? [primary] : [];
    try {
      verifyFileManifest(source, sourceManifest, 'quality source after failed run');
    } catch (err) {
      errors.push(err);
    }
    try {
      safeRmSync(tree, { recursive: true, force: true });
    } catch (err) {
      errors.push(err);
    }
    if (existsSync(tree)) errors.push(new Error(`quality staging cleanup left path: ${tree}`));
    if (errors.length > 1) throw new AggregateError(errors, 'quality run and staging cleanup failed');
    if (errors.length === 1) throw errors[0];
  };
  const publish = () => {
    if (settled) throw new Error('quality work tree is already settled');
    verifyFileManifest(source, sourceManifest, 'quality source after run');
    verifyFileManifest(tree, copiedManifest, 'quality run corpus after run');
    const senseManifest = treeManifest(join(tree, '.sense'));
    if (senseManifest.length === 0) throw new Error('quality run produced no native cache files');
    const marker = { version: 1, cache_fingerprint: cacheFingerprint, cache_inputs: inputs, copied_manifest: copiedManifest, sense_manifest: senseManifest };
    const markerTmp = join(tree, `${MARKER}.${randomUUID()}.tmp`);
    writeFileSync(markerTmp, JSON.stringify(marker));
    renameSync(markerTmp, join(tree, MARKER));
    mkdirSync(completedRoot, { recursive: true });
    const completed = join(completedRoot, `${cacheFingerprint}-${basename(tree)}`);
    renameSync(tree, completed);
    settled = true;
    return { tree: completed, cache_fingerprint: cacheFingerprint, cache_inputs: inputs, reuse_state: reused ? 'copied-completed-index' : 'source-copy', reused_generation: reused };
  };
  return { tree, sourceManifest, copiedManifest, copied_state: manifestIdentity(copiedManifest, { includeMtime: true }), cacheFingerprint, cacheInputs: inputs, reuse_state: reused ? 'copied-completed-index' : 'source-copy', reused_generation: reused, publish, discard };
}
