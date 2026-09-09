// A corpus tree copy that keeps the pinned cache entry read-only: every write a measurement
// makes (.sense, sense.config.json, touched mtimes) lands in the copy, never in .tmp/cache.
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeRmSync } from 'fs-remove-compat';

// Same shape across every OS: cpSync's filter receives whatever separator the platform uses.
const EXCLUDE = /[/\\](\.sense|\.git|\.obsidian|node_modules)([/\\]|$)/;

// preserveTimestamps: cpSync's default re-stamps every file to the copy time, which would make
// two separate captures of an unchanged corpus (store-dump.mjs's before/after workflow) always
// disagree on _mtime. Preserving the source's real mtimes keeps that comparison meaningful.
export function copyTree(source, dest) {
  cpSync(source, dest, { recursive: true, preserveTimestamps: true, filter: (src) => !EXCLUDE.test(src) });
}

// A private copy used for one run and discarded (run.mjs, store-dump.mjs capture): the caller
// removes it with safeRmSync when done.
export function ephemeralWorkTree(tmpRoot, prefix, source) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, prefix));
  try {
    copyTree(source, dir);
    return dir;
  } catch (err) {
    safeRmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function safeFilePath(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || isAbsolute(rel)) throw new Error(`canonical file path must be relative: ${String(rel)}`);
  const rootPath = resolve(root);
  if (lstatSync(rootPath).isSymbolicLink()) throw new Error(`canonical tree root is a symlink: ${root}`);
  const filePath = resolve(rootPath, rel);
  const outside = relative(rootPath, filePath);
  if (outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside)) throw new Error(`canonical file path escapes tree: ${rel}`);
  let current = rootPath;
  for (const component of outside.split(sep)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`canonical file path contains a symlink: ${rel}`);
  }
  return filePath;
}

// Sorted relative paths of the Markdown entries a crawl sees. A symlink ending in .md stays in
// the list so safeFilePath rejects it explicitly instead of silently changing the corpus.
export function walkMd(tree) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(join(tree, dir), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  })('');
  return out.sort();
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function captureFile(filePath, rel) {
  const stat = lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`canonical path is not a regular file: ${rel}`);
  return { rel, bytes: stat.size, mtimeMs: stat.mtimeMs, sha256: hashFile(filePath) };
}

// A compact, disk-backed identity for a corpus. Bytes are read one file at a time and never
// retained in the manifest, so verifying a large corpus cannot consume its full size in JS.
export function captureFileManifest(tree, relPaths = walkMd(tree)) {
  const paths = [...relPaths].sort();
  if (new Set(paths).size !== paths.length) throw new Error('canonical file manifest contains duplicate paths');
  return paths.map((rel) => captureFile(safeFilePath(tree, rel), rel));
}

export function fileManifestFingerprint(manifest) {
  return createHash('sha256')
    .update(JSON.stringify(manifest.map(({ rel, bytes, mtimeMs, sha256 }) => [rel, bytes, mtimeMs, sha256])))
    .digest('hex');
}

// Verifies path identity as well as file metadata/content. A same-count, wrong-path set is an
// invalid state, not a partial match. The expected mtime is exact: timestamp precision loss is
// surfaced rather than hidden behind a tolerance.
export function verifyFileManifest(tree, expected, label = 'file manifest') {
  const actualPaths = walkMd(tree);
  const expectedPaths = new Set(expected.map(({ rel }) => rel));
  for (const rel of actualPaths) if (!expectedPaths.has(rel)) throw new Error(`${label} has an unexpected path: ${rel}`);
  const actual = captureFileManifest(tree, actualPaths);
  if (actual.length !== expected.length) throw new Error(`${label} path count mismatch: expected ${expected.length}, got ${actual.length}`);
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i];
    const got = actual[i];
    if (want.rel !== got.rel) throw new Error(`${label} path mismatch at ${i}: expected ${want.rel}, got ${got.rel}`);
    for (const key of ['bytes', 'mtimeMs', 'sha256']) {
      if (want[key] !== got[key]) throw new Error(`${label} ${want.rel} ${key} mismatch: expected ${want[key]}, got ${got[key]}`);
    }
  }
  return actual;
}

export function verifyManifestContents(actual, expected, label = 'file manifest contents') {
  const expectedByPath = new Map(expected.map((entry) => [entry.rel, entry]));
  if (new Set(actual.map((entry) => entry.rel)).size !== actual.length) throw new Error(`${label} contains duplicate paths`);
  if (actual.length !== expectedByPath.size) throw new Error(`${label} path count mismatch: expected ${expectedByPath.size}, got ${actual.length}`);
  for (const entry of actual) {
    const wanted = expectedByPath.get(entry.rel);
    if (!wanted) throw new Error(`${label} has an unexpected path: ${entry.rel}`);
    for (const key of ['bytes', 'sha256']) {
      if (entry[key] !== wanted[key]) throw new Error(`${label} ${entry.rel} ${key} mismatch: expected ${wanted[key]}, got ${entry[key]}`);
    }
  }
}

export function captureMutationFiles(tree, manifest, relPaths) {
  const expectedByPath = new Map(manifest.map((entry) => [entry.rel, entry]));
  return [...relPaths].map((rel) => {
    const expected = expectedByPath.get(rel);
    if (!expected) throw new Error(`mutation path is not in the canonical manifest: ${rel}`);
    const filePath = safeFilePath(tree, rel);
    const actual = captureFile(filePath, rel);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes || actual.mtimeMs !== expected.mtimeMs) throw new Error(`canonical mutation input changed before capture: ${rel}`);
    return { ...expected, content: readFileSync(filePath) };
  });
}

export function deterministicMutationMtime(manifest) {
  const maxMtimeMs = manifest.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
  return Math.floor(maxMtimeMs / 1000) * 1000 + 60_000;
}

/** @param {*} tree @param {*[]} manifest @param {*[]} canonicalFiles @param {{ append?: string | null, mtimeMs: number }} options */
export function applyDeterministicMutation(tree, manifest, canonicalFiles, options) {
  const { append = null, mtimeMs } = options;
  const expectedByPath = new Map(manifest.map((entry) => [entry.rel, entry]));
  for (const canonical of canonicalFiles) {
    const filePath = safeFilePath(tree, canonical.rel);
    const content = append === null ? null : Buffer.concat([canonical.content, Buffer.from(append)]);
    if (content !== null) writeFileSync(filePath, content);
    utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);
    const expected = content === null ? { rel: canonical.rel, bytes: canonical.bytes, mtimeMs, sha256: canonical.sha256 } : { rel: canonical.rel, bytes: content.length, mtimeMs, sha256: createHash('sha256').update(content).digest('hex') };
    const actual = captureFile(filePath, canonical.rel);
    for (const key of ['bytes', 'mtimeMs', 'sha256']) {
      if (actual[key] !== expected[key]) throw new Error(`deterministic mutation ${canonical.rel} ${key} mismatch: expected ${expected[key]}, got ${actual[key]}`);
    }
    expectedByPath.set(canonical.rel, expected);
  }
  const expected = [...expectedByPath.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  verifyFileManifest(tree, expected, 'mutated manifest');
  return expected;
}

const rowHash = (row) =>
  createHash('sha256')
    .update(JSON.stringify([row.title ?? null, row.summary ?? null, row.text ?? null]))
    .digest('hex');
const INDEX_PAGE_SIZE = 128;

// Runtime snapshots detect repeated-input and stale-index state; authored fixture expectations are
// the independent correctness oracle (PRINCIPLES: proven-or-verified).
/** @param {*} handle @param {{ expectedContent?: Map<string, { title: string | null, summary: string | null, text: string | null }> | null }} options */
export async function readIndexSnapshot(handle, options = {}) {
  const { expectedContent = null } = options;
  const metadata = new Map();
  const metadataStmt = await handle.prepare('SELECT "path", "_mtime", "_size" FROM frontmatter');
  for (const row of await metadataStmt.all()) {
    if (metadata.has(row.path)) throw new Error(`indexed metadata has a duplicate path: ${row.path}`);
    metadata.set(row.path, { mtimeMs: Number(row._mtime), bytes: Number(row._size) });
  }

  const content = new Map();
  const contentStmt = await handle.prepare('SELECT "path", title, summary, text FROM content ORDER BY "path" LIMIT ? OFFSET ?');
  for (let offset = 0; ; offset += INDEX_PAGE_SIZE) {
    const rows = await contentStmt.all(INDEX_PAGE_SIZE, offset);
    for (const row of rows) {
      if (content.has(row.path)) throw new Error(`indexed content has a duplicate path: ${row.path}`);
      const authored = expectedContent?.get(row.path);
      if (authored) {
        for (const key of ['title', 'summary', 'text']) {
          const actual = row[key] ?? null;
          if (actual !== authored[key]) throw new Error(`indexed content ${row.path} ${key} mismatch: expected ${JSON.stringify(authored[key])}, got ${JSON.stringify(actual)}`);
        }
      }
      content.set(row.path, rowHash(row));
    }
    if (rows.length < INDEX_PAGE_SIZE) break;
  }
  const canonicalContent = [...content].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { metadata, content, fingerprint: createHash('sha256').update(JSON.stringify(canonicalContent)).digest('hex') };
}

function assertExactPaths(actual, expected, label) {
  if (actual.size !== expected.size) throw new Error(`${label} path count mismatch: expected ${expected.size}, got ${actual.size}`);
  for (const rel of expected.keys()) if (!actual.has(rel)) throw new Error(`${label} is missing path: ${rel}`);
  for (const rel of actual.keys()) if (!expected.has(rel)) throw new Error(`${label} has an unexpected path: ${rel}`);
}

export function verifyIndexSnapshot(snapshot, manifest, label = 'indexed state') {
  const mismatch = indexSnapshotMismatch(snapshot, manifest);
  if (mismatch) throw new Error(`${label} ${mismatch}`);
}

// A non-throwing state check lets watcher polling retry stale state without swallowing native errors.
// Baseline content hashes are state identity, not an independent parsing oracle.
export function indexSnapshotMismatch(snapshot, manifest, expectedContent = null) {
  const expected = new Map(manifest.map((entry) => [entry.rel, entry]));
  if (snapshot.metadata.size !== expected.size) return `metadata path count mismatch: expected ${expected.size}, got ${snapshot.metadata.size}`;
  if (snapshot.content.size !== expected.size) return `content path count mismatch: expected ${expected.size}, got ${snapshot.content.size}`;
  for (const [rel, wanted] of expected) {
    const metadata = snapshot.metadata.get(rel);
    if (!metadata) return `metadata is missing path: ${rel}`;
    if (metadata.mtimeMs !== wanted.mtimeMs) return `${rel} mtime mismatch: expected ${wanted.mtimeMs}, got ${metadata.mtimeMs}`;
    if (metadata.bytes !== wanted.bytes) return `${rel} size mismatch: expected ${wanted.bytes}, got ${metadata.bytes}`;
    if (!snapshot.content.has(rel)) return `content is missing path: ${rel}`;
  }
  for (const rel of snapshot.metadata.keys()) if (!expected.has(rel)) return `metadata has an unexpected path: ${rel}`;
  for (const rel of snapshot.content.keys()) if (!expected.has(rel)) return `content has an unexpected path: ${rel}`;
  if (expectedContent) {
    if (snapshot.content.size !== expectedContent.size) return `content identity path count: expected ${expectedContent.size}, got ${snapshot.content.size}`;
    for (const [rel, hash] of expectedContent) {
      if (!snapshot.content.has(rel)) return `content identity missing path: ${rel}`;
      if (snapshot.content.get(rel) !== hash) return `content identity mismatch: ${rel}`;
    }
    for (const rel of snapshot.content.keys()) if (!expectedContent.has(rel)) return `content identity unexpected path: ${rel}`;
  }
  return null;
}

export function verifyContentTransition(before, after, changedPaths = []) {
  assertExactPaths(after.content, before.content, 'indexed content transition');
  const changed = new Set(changedPaths);
  for (const [rel, hash] of before.content) {
    if (changed.has(rel)) {
      if (after.content.get(rel) === hash) throw new Error(`indexed content did not change for: ${rel}`);
    } else if (after.content.get(rel) !== hash) throw new Error(`indexed content changed unexpectedly for: ${rel}`);
  }
}

export function verifyRepeatFingerprint(expected, actual, label) {
  if (expected !== null && actual !== expected) throw new Error(`${label} repetition fingerprint mismatch: expected ${expected}, got ${actual}`);
  return expected ?? actual;
}

/** @param {*} open @param {*} cfg @param {*[]} manifest @param {{ label?: string, expectedContent?: Map<string, { title: string | null, summary: string | null, text: string | null }> | null }} options */
export async function openVerified(open, cfg, manifest, options = {}) {
  const { label = 'indexed state', expectedContent = null } = options;
  let opened;
  const started = process.hrtime.bigint();
  try {
    opened = await open(cfg);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const handle = opened.store ?? opened.db;
    const snapshot = await readIndexSnapshot(handle, { expectedContent });
    verifyIndexSnapshot(snapshot, manifest, label);
    return { ms, stages: opened.stages ?? null, snapshot };
  } finally {
    if (opened) await (opened.store ?? opened.db).close();
  }
}
