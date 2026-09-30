import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalJson } from './canonical-json.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const READ_BUFFER_BYTES = 64 * 1024;
const REPRESENTATIVE_STRING_BYTES = 256;
export const STORE_DUMP_EVIDENCE_VERSION = 2;
export const STORE_DUMP_REPRESENTATIVE_LIMIT = 8;
export const STORE_DUMP_REPRESENTATIVE_BYTES = 8 * 1024;

function hashFile(path) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const descriptor = openSync(path, 'r');
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function filesEqual(pathA, pathB) {
  if (statSync(pathA).size !== statSync(pathB).size) return false;
  let descriptorA;
  let descriptorB;
  let bodyError;
  let bodyFailed = false;
  let equal = false;
  const cleanupErrors = [];
  const bufferA = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const bufferB = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  try {
    descriptorA = openSync(pathA, 'r');
    descriptorB = openSync(pathB, 'r');
    while (true) {
      const bytesA = readSync(descriptorA, bufferA, 0, bufferA.length, null);
      const bytesB = readSync(descriptorB, bufferB, 0, bufferB.length, null);
      if (bytesA !== bytesB || !bufferA.subarray(0, bytesA).equals(bufferB.subarray(0, bytesB))) break;
      if (bytesA === 0) {
        equal = true;
        break;
      }
    }
  } catch (error) {
    bodyError = error;
    bodyFailed = true;
  } finally {
    for (const descriptor of [descriptorA, descriptorB]) {
      if (descriptor === undefined) continue;
      try {
        closeSync(descriptor);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (bodyFailed && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], 'file comparison and descriptor cleanup failed');
  if (bodyFailed) throw bodyError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'descriptor cleanup failed');
  return equal;
}

function* fileLines(path) {
  const descriptor = openSync(path, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let fragments = [];
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      const decoded = decoder.write(buffer.subarray(0, bytes));
      let start = 0;
      while (true) {
        const newline = decoded.indexOf('\n', start);
        if (newline === -1) break;
        fragments.push(decoded.slice(start, newline));
        yield fragments.join('');
        fragments = [];
        start = newline + 1;
      }
      if (start < decoded.length) fragments.push(decoded.slice(start));
    }
    const tail = decoder.end();
    if (tail.length > 0) fragments.push(tail);
    if (fragments.length > 0) yield fragments.join('');
  } finally {
    closeSync(descriptor);
  }
}

function relativePath(path) {
  return path.split(sep).join('/');
}

function assertContained(root, candidate) {
  const rootPath = resolve(root);
  if (lstatSync(rootPath).isSymbolicLink()) throw new Error(`capture root is a symlink: ${root}`);
  const candidatePath = resolve(rootPath, candidate);
  const lexical = relative(rootPath, candidatePath);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new Error(`capture path escapes sitting: ${candidate}`);
  let current = rootPath;
  for (const component of lexical ? lexical.split(sep) : []) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`capture path contains a symlink: ${candidate}`);
  }
  const realRoot = realpathSync(rootPath);
  const realCandidate = realpathSync(candidatePath);
  const realRelative = relative(realRoot, realCandidate);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) throw new Error(`capture path resolves outside sitting: ${candidate}`);
  return candidatePath;
}

export function resolveCaptureDirectory(sittingDir, capturePath) {
  if (typeof capturePath !== 'string' || capturePath.length === 0) throw new Error('capture path is missing');
  const path = assertContained(sittingDir, capturePath);
  if (!statSync(path).isDirectory()) throw new Error(`capture path is not a directory: ${capturePath}`);
  return path;
}

export function captureIdentity(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`capture contains a symlink: ${rel}`);
      if (entry.isDirectory()) walk(path, rel);
      else if (entry.isFile()) files.push({ path: relativePath(rel), bytes: statSync(path).size, sha256: hashFile(path) });
      else throw new Error(`capture contains a non-regular entry: ${rel}`);
    }
  };
  walk(root, '');
  return { path: root, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

function rowIdentity(section, value, rowIndex) {
  const key = (...parts) => JSON.stringify(parts);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return `row:${rowIndex}`;
  switch (section) {
    case 'frontmatter':
    case 'content':
      return key(value.path);
    case 'preset_files':
      return key(value.path, value.preset);
    case 'links':
      return key(value.src, value.target, value.embed);
    case 'sections':
      return key(value.path, value.idx);
    case 'tags':
      return key(value.path, value.tag);
    case 'embeddings':
      return key(value.path, value.chunk);
    default:
      return typeof value.path === 'string' ? key(value.path) : `row:${rowIndex}`;
  }
}

function parseValue(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { raw: line };
  }
}

export function structuredRows(text) {
  const sections = [];
  let section = null;
  const occurrences = new Map();
  for (const line of text.split('\n')) {
    const header = /^== (.+) \((\d+) rows\) ==$/.exec(line);
    if (header) {
      section = { identity: header[1], rows: [] };
      sections.push(section);
      occurrences.clear();
      continue;
    }
    if (!section || line.trim() === '') continue;
    const value = parseValue(line);
    const base = rowIdentity(section.identity, value, section.rows.length);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const identity = occurrence === 0 ? base : `${base}#${occurrence}`;
    section.rows.push({ identity, value, sha256: createHash('sha256').update(line).digest('hex') });
  }
  return sections;
}

function streamedSections(path) {
  const sections = [];
  let section = null;
  let sectionHash = null;
  let firstRow = true;
  const occurrences = new Map();
  const finishSection = () => {
    if (!section) return;
    sectionHash.update(']}');
    section.sha256 = sectionHash.digest('hex');
  };
  for (const line of fileLines(path)) {
    const header = /^== (.+) \((\d+) rows\) ==$/.exec(line);
    if (header) {
      finishSection();
      section = { identity: header[1], rows: [], sha256: null };
      sections.push(section);
      sectionHash = createHash('sha256').update(`{"identity":${JSON.stringify(section.identity)},"rows":[`);
      firstRow = true;
      occurrences.clear();
      continue;
    }
    if (!section || line.trim() === '') continue;
    const value = parseValue(line);
    const base = rowIdentity(section.identity, value, section.rows.length);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const identity = occurrence === 0 ? base : `${base}#${occurrence}`;
    const sha256 = createHash('sha256').update(line).digest('hex');
    const valueJson = JSON.stringify(value);
    if (!firstRow) sectionHash.update(',');
    sectionHash.update(`{"identity":${JSON.stringify(identity)},"value":${valueJson},"sha256":${JSON.stringify(sha256)}}`);
    firstRow = false;
    const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
    section.rows.push({
      identity,
      sha256,
      value_sha256: createHash('sha256').update(valueJson).digest('hex'),
      schema: JSON.stringify(keys),
      numeric: keys.some((key) => /(?:score|similarity|rank|value)$/i.test(key) && typeof value[key] === 'number'),
      snippet: keys.some((key) => /snippet|hit|line/i.test(key)),
    });
  }
  finishSection();
  return sections;
}

function boundedString(value) {
  const bytes = Buffer.from(value);
  if (bytes.length <= REPRESENTATIVE_STRING_BYTES) return value;
  return {
    truncated_utf8: true,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    prefix_base64: bytes.subarray(0, REPRESENTATIVE_STRING_BYTES).toString('base64'),
  };
}

function boundedRepresentative(value) {
  if (typeof value === 'string') return boundedString(value);
  if (Array.isArray(value)) return value.map(boundedRepresentative);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, boundedRepresentative(child)]));
  return value;
}

function summaryBuilder() {
  return { count: 0, hash: createHash('sha256'), representatives: [], representativeBytes: 0 };
}

function addSummaryEntry(builder, entry) {
  const canonical = canonicalJson(entry);
  builder.hash
    .update(String(Buffer.byteLength(canonical)))
    .update(':')
    .update(canonical);
  builder.count++;
  if (builder.representatives.length >= STORE_DUMP_REPRESENTATIVE_LIMIT) return;
  const representative = boundedRepresentative(entry);
  const bytes = Buffer.byteLength(JSON.stringify(representative));
  if (builder.representativeBytes + bytes > STORE_DUMP_REPRESENTATIVE_BYTES) return;
  builder.representatives.push(representative);
  builder.representativeBytes += bytes;
}

function finishSummary(builder) {
  return { count: builder.count, sha256: builder.hash.digest('hex'), representatives: builder.representatives, omitted: builder.count - builder.representatives.length };
}

function summarizeEntries(entries) {
  const builder = summaryBuilder();
  for (const entry of entries) addSummaryEntry(builder, entry);
  return finishSummary(builder);
}

function changedEntryCategories(before, after) {
  const categories = new Set();
  if (!before || !after) categories.add('membership');
  if (before && after) {
    if (before.schema !== after.schema) categories.add('schema');
    const changed = before.value_sha256 !== after.value_sha256;
    if (changed) categories.add('value');
    if (after.numeric && changed) categories.add('score');
    if (after.snippet && changed) categories.add('snippet');
  }
  return [...categories];
}

function structuredFileDiff(store, artifact, pathA, pathB, observeCategory) {
  const beforeExists = existsSync(pathA);
  const afterExists = existsSync(pathB);
  const beforeSha256 = beforeExists ? hashFile(pathA) : null;
  const afterSha256 = afterExists ? hashFile(pathB) : null;
  const equal = beforeExists && afterExists && filesEqual(pathA, pathB);
  const changed = summaryBuilder();
  const categories = new Map();
  const record = (entry, categoryEntries) => {
    addSummaryEntry(changed, entry);
    for (const [category, detail] of categoryEntries) {
      if (!categories.has(category)) categories.set(category, summaryBuilder());
      addSummaryEntry(categories.get(category), detail);
      observeCategory(category, detail);
    }
  };
  if (!equal) {
    const beforeSections = beforeExists ? streamedSections(pathA) : [];
    const afterSections = afterExists ? streamedSections(pathB) : [];
    const sectionCount = Math.max(beforeSections.length, afterSections.length);
    for (let i = 0; i < sectionCount; i++) {
      const beforeSection = beforeSections[i];
      const afterSection = afterSections[i];
      const section = afterSection ?? beforeSection;
      const beforeById = new Map((beforeSection?.rows ?? []).map((row, index) => [row.identity, { ...row, index }]));
      const afterById = new Map((afterSection?.rows ?? []).map((row, index) => [row.identity, { ...row, index }]));
      const identities = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
      for (const identity of identities) {
        const beforeRow = beforeById.get(identity);
        const afterRow = afterById.get(identity);
        if (beforeRow?.sha256 === afterRow?.sha256 && beforeRow.index === afterRow.index) continue;
        const rowCategories = changedEntryCategories(beforeRow, afterRow);
        if (beforeRow && afterRow && beforeRow.index !== afterRow.index) rowCategories.push('order');
        const uniqueCategories = [...new Set(rowCategories)];
        const detail = { store, artifact, section: section.identity, identity, before_index: beforeRow?.index ?? null, after_index: afterRow?.index ?? null, before_sha256: beforeRow?.sha256 ?? null, after_sha256: afterRow?.sha256 ?? null };
        record(
          { store, artifact, section: section.identity, identity, before_sha256: beforeRow?.sha256 ?? null, after_sha256: afterRow?.sha256 ?? null, categories: uniqueCategories },
          uniqueCategories.map((category) => [category, detail])
        );
      }
      if (beforeSection?.identity !== afterSection?.identity) {
        const sectionCategories = artifact === 'ranking.txt' ? ['query', 'membership'] : ['schema', 'membership'];
        const entry = { store, artifact, section: section.identity, identity: `section:${i}`, before_sha256: beforeSection?.sha256 ?? null, after_sha256: afterSection?.sha256 ?? null, categories: sectionCategories };
        record(
          entry,
          entry.categories.map((category) => [category, entry])
        );
      }
    }
    if (beforeExists !== afterExists) {
      const entry = { store, artifact, section: artifact, identity: `file:${artifact}`, before_sha256: beforeSha256, after_sha256: afterSha256, categories: ['schema', 'membership'] };
      record(
        entry,
        entry.categories.map((category) => [category, entry])
      );
    }
  }
  return {
    before_exists: beforeExists,
    after_exists: afterExists,
    before_sha256: beforeSha256,
    after_sha256: afterSha256,
    equal,
    changed_entries: finishSummary(changed),
    categories: Object.fromEntries([...categories].map(([category, builder]) => [category, finishSummary(builder)])),
  };
}

function captureArtifacts(dir, store) {
  const names = ['tables.txt', 'ranking.txt'];
  if (existsSync(join(dir, store, 'notices.txt'))) names.push('notices.txt');
  return names;
}

export function compareCaptureDirectories(dirA, dirB) {
  const storesA = readdirSync(dirA, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const storesB = readdirSync(dirB, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const stores = [...new Set([...storesA, ...storesB])].sort();
  const perStore = {};
  const changedFiles = [];
  const categories = new Map();
  const observeCategory = (category, entry) => {
    if (!categories.has(category)) categories.set(category, summaryBuilder());
    addSummaryEntry(categories.get(category), entry);
  };
  for (const store of stores) {
    const presentA = storesA.includes(store);
    const presentB = storesB.includes(store);
    const artifacts = presentA && presentB ? [...new Set([...captureArtifacts(dirA, store), ...captureArtifacts(dirB, store)])] : [];
    const result = { ok: presentA && presentB && artifacts.length > 0, artifacts, files: {} };
    if (!presentA || !presentB) result.reason = 'store is present in only one directory';
    if (artifacts.length === 0) result.reason = result.reason ?? 'store has no retained artifacts';
    for (const artifact of artifacts) {
      const file = structuredFileDiff(store, artifact, join(dirA, store, artifact), join(dirB, store, artifact), observeCategory);
      result.files[artifact] = file;
      result.ok = file.equal && result.ok;
      if (!file.equal) changedFiles.push({ store, artifact, before_sha256: file.before_sha256, after_sha256: file.after_sha256, changed_entries: file.changed_entries });
    }
    perStore[store] = result;
  }
  return {
    stores: perStore,
    ok: Object.values(perStore).length > 0 && Object.values(perStore).every((result) => result.ok),
    diff: { version: STORE_DUMP_EVIDENCE_VERSION, changed_files: changedFiles, categories: Object.fromEntries([...categories].map(([category, builder]) => [category, finishSummary(builder)])) },
  };
}

function sameShape(actual, expected) {
  return canonicalJson(actual) === canonicalJson(expected);
}

function summaryError(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return 'is not a summary object';
  if (!Number.isSafeInteger(summary.count) || summary.count < 0) return 'has an invalid count';
  if (!SHA256.test(summary.sha256 ?? '')) return 'has an invalid digest';
  if (!Array.isArray(summary.representatives) || summary.representatives.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) return 'has malformed representatives';
  if (summary.representatives.length > STORE_DUMP_REPRESENTATIVE_LIMIT) return 'has too many representatives';
  if (!Number.isSafeInteger(summary.omitted) || summary.omitted < 0 || summary.omitted !== summary.count - summary.representatives.length) return 'has an invalid omitted count';
  const bytes = summary.representatives.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)), 0);
  if (bytes > STORE_DUMP_REPRESENTATIVE_BYTES) return 'has oversized representatives';
  return null;
}

function evidenceVersion(diff) {
  if (!Object.hasOwn(diff, 'version')) return 1;
  if (diff.version !== STORE_DUMP_EVIDENCE_VERSION) throw new Error(`unsupported structured diff version: ${String(diff.version)}`);
  return STORE_DUMP_EVIDENCE_VERSION;
}

function normalizeCollection(collection, version) {
  if (version === 1) {
    if (!Array.isArray(collection) || collection.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) throw new Error('legacy evidence collection is malformed');
    return summarizeEntries(collection);
  }
  const error = summaryError(collection);
  if (error) throw new Error(`evidence summary ${error}`);
  return collection;
}

export function normalizeStoreDumpEvidence(stores, diff) {
  if (!stores || typeof stores !== 'object' || Array.isArray(stores) || !diff || typeof diff !== 'object' || Array.isArray(diff)) throw new Error('store-dump evidence is missing stores or diff');
  const version = evidenceVersion(diff);
  const normalizedStores = Object.fromEntries(
    Object.entries(stores).map(([store, result]) => [
      store,
      {
        ...result,
        files: Object.fromEntries(
          Object.entries(result.files ?? {}).map(([artifact, file]) => [
            artifact,
            {
              ...file,
              changed_entries: normalizeCollection(file.changed_entries, version),
              categories: Object.fromEntries(Object.entries(file.categories ?? {}).map(([category, entries]) => [category, normalizeCollection(entries, version)])),
            },
          ])
        ),
      },
    ])
  );
  return {
    version,
    stores: normalizedStores,
    diff: {
      ...diff,
      version: STORE_DUMP_EVIDENCE_VERSION,
      changed_files: (diff.changed_files ?? []).map((file) => ({ ...file, changed_entries: normalizeCollection(file.changed_entries, version) })),
      categories: Object.fromEntries(Object.entries(diff.categories ?? {}).map(([category, entries]) => [category, normalizeCollection(entries, version)])),
    },
  };
}

function validateCollection(collection, version) {
  if (version === 1) return Array.isArray(collection) && collection.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  return summaryError(collection) === null;
}

export function validateStoreDumpArtifact(artifact, sittingDir, baseline, stores) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return ['artifact is not an object'];
  if (typeof artifact.baseline !== 'string' || artifact.baseline.length === 0) errors.push('baseline is missing');
  else if (artifact.baseline !== baseline) errors.push(`baseline ${artifact.baseline} does not match sitting baseline ${baseline}`);
  if (typeof artifact.ok !== 'boolean') errors.push('ok must be boolean');
  const paths = {};
  if (!artifact.captures || typeof artifact.captures !== 'object' || Array.isArray(artifact.captures)) errors.push('captures are missing');
  else
    for (const side of ['before', 'after']) {
      try {
        paths[side] = resolveCaptureDirectory(sittingDir, artifact.captures[side]);
      } catch (error) {
        errors.push(`capture ${side} is invalid: ${error.message}`);
      }
    }
  if (!artifact.capture_identity || typeof artifact.capture_identity !== 'object' || Array.isArray(artifact.capture_identity)) errors.push('capture identities are missing');
  else
    for (const side of ['before', 'after']) {
      const identity = artifact.capture_identity[side];
      if (!identity || !SHA256.test(identity.sha256 ?? '') || !Array.isArray(identity.files)) errors.push(`capture identity ${side} is malformed`);
      else if (paths[side]) {
        try {
          const actual = captureIdentity(paths[side]);
          if (!sameShape({ sha256: identity.sha256, files: identity.files }, { sha256: actual.sha256, files: actual.files })) errors.push(`capture identity ${side} does not match retained capture`);
        } catch (error) {
          errors.push(`capture identity ${side} cannot be recomputed: ${error.message}`);
        }
      }
    }
  let version = null;
  if (!artifact.diff || typeof artifact.diff !== 'object' || Array.isArray(artifact.diff)) errors.push('structured diff is missing changed_files or categories');
  else {
    try {
      version = evidenceVersion(artifact.diff);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (!artifact.stores || typeof artifact.stores !== 'object' || Array.isArray(artifact.stores)) errors.push('stores are missing');
  else if (version !== null) {
    for (const store of stores) {
      const result = artifact.stores[store];
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        errors.push(`${store} comparison is malformed`);
        continue;
      }
      const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
      const files = result.files && typeof result.files === 'object' && !Array.isArray(result.files) ? result.files : {};
      if (typeof result.ok !== 'boolean' || artifacts !== result.artifacts || files !== result.files) errors.push(`${store} comparison has malformed per-store evidence`);
      if (new Set(artifacts).size !== artifacts.length) errors.push(`${store} comparison has duplicate artifact identities`);
      for (const artifactName of artifacts) if (!Object.hasOwn(files, artifactName)) errors.push(`${store} comparison is missing ${artifactName} file evidence`);
      for (const [artifactName, file] of Object.entries(files)) {
        if (!file || typeof file !== 'object' || typeof file.equal !== 'boolean' || !validateCollection(file.changed_entries, version) || !file.categories || typeof file.categories !== 'object' || Array.isArray(file.categories)) errors.push(`${store}/${artifactName} file evidence is malformed`);
        else for (const [category, entries] of Object.entries(file.categories)) if (!validateCollection(entries, version)) errors.push(`${store}/${artifactName} category ${category} is malformed`);
      }
    }
    const unknownStores = Object.keys(artifact.stores).filter((store) => !stores.includes(store));
    if (unknownStores.length > 0) errors.push(`unknown store evidence: ${unknownStores.join(', ')}`);
  }
  if (version !== null) {
    if (!Array.isArray(artifact.diff.changed_files) || !artifact.diff.categories || typeof artifact.diff.categories !== 'object' || Array.isArray(artifact.diff.categories)) errors.push('structured diff is missing changed_files or categories');
    else {
      for (const file of artifact.diff.changed_files) if (!file || typeof file !== 'object' || !validateCollection(file.changed_entries, version)) errors.push('structured diff changed file is malformed');
      for (const [category, entries] of Object.entries(artifact.diff.categories)) if (!validateCollection(entries, version)) errors.push(`structured diff category ${category} is malformed`);
    }
  }
  if (paths.before && paths.after && artifact.stores && artifact.diff && version !== null) {
    try {
      const recomputed = compareCaptureDirectories(paths.before, paths.after);
      const recorded = normalizeStoreDumpEvidence(artifact.stores, artifact.diff);
      if (!sameShape(recorded.stores, recomputed.stores)) errors.push('per-store evidence does not match retained captures');
      if (!sameShape(recorded.diff, recomputed.diff)) errors.push('structured diff does not match retained captures');
      if (artifact.ok !== recomputed.ok) errors.push(`ok ${artifact.ok} does not match retained captures (${recomputed.ok})`);
    } catch (error) {
      errors.push(`retained capture comparison failed: ${error.message}`);
    }
  }
  return errors;
}
