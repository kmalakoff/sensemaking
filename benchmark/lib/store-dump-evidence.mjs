import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SHA256 = /^[0-9a-f]{64}$/;
function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

function serializeSection(section) {
  return JSON.stringify(section);
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
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      value = { raw: line };
    }
    const base = rowIdentity(section.identity, value, section.rows.length);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    const identity = occurrence === 0 ? base : `${base}#${occurrence}`;
    section.rows.push({ identity, value, sha256: createHash('sha256').update(line).digest('hex') });
  }
  return sections;
}

function changedEntryCategories(before, after) {
  const categories = new Set();
  const beforeValue = before?.value;
  const afterValue = after?.value;
  if (!before || !after) categories.add('membership');
  if (before && after) {
    const beforeKeys = Object.keys(beforeValue ?? {}).sort();
    const afterKeys = Object.keys(afterValue ?? {}).sort();
    if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) categories.add('schema');
    const changed = JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
    if (changed) categories.add('value');
    const numeric = Object.keys(afterValue ?? {}).some((key) => /(?:score|similarity|rank|value)$/i.test(key) && typeof afterValue[key] === 'number');
    if (numeric && changed) categories.add('score');
    const snippets = Object.keys(afterValue ?? {}).some((key) => /snippet|hit|line/i.test(key));
    if (snippets && changed) categories.add('snippet');
  }
  return [...categories];
}

function structuredFileDiff(store, artifact, pathA, pathB) {
  const beforeExists = existsSync(pathA);
  const afterExists = existsSync(pathB);
  const beforeText = beforeExists ? readFileSync(pathA, 'utf8') : '';
  const afterText = afterExists ? readFileSync(pathB, 'utf8') : '';
  const beforeSections = structuredRows(beforeText);
  const afterSections = structuredRows(afterText);
  const changed = [];
  const categories = new Map();
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
      for (const category of uniqueCategories)
        categories.set(category, [...(categories.get(category) ?? []), { store, artifact, section: section.identity, identity, before_index: beforeRow?.index ?? null, after_index: afterRow?.index ?? null, before_sha256: beforeRow?.sha256 ?? null, after_sha256: afterRow?.sha256 ?? null }]);
      changed.push({ store, artifact, section: section.identity, identity, before_sha256: beforeRow?.sha256 ?? null, after_sha256: afterRow?.sha256 ?? null, categories: uniqueCategories });
    }
    if (beforeSection?.identity !== afterSection?.identity) {
      const beforeHash = beforeSection ? createHash('sha256').update(serializeSection(beforeSection)).digest('hex') : null;
      const afterHash = afterSection ? createHash('sha256').update(serializeSection(afterSection)).digest('hex') : null;
      const sectionCategories = artifact === 'ranking.txt' ? ['query', 'membership'] : ['schema', 'membership'];
      const entry = { store, artifact, section: section.identity, identity: `section:${i}`, before_sha256: beforeHash, after_sha256: afterHash, categories: sectionCategories };
      changed.push(entry);
      for (const category of entry.categories) categories.set(category, [...(categories.get(category) ?? []), entry]);
    }
  }
  if (beforeExists !== afterExists) {
    const entry = { store, artifact, section: artifact, identity: `file:${artifact}`, before_sha256: beforeExists ? hashFile(pathA) : null, after_sha256: afterExists ? hashFile(pathB) : null, categories: ['schema', 'membership'] };
    changed.push(entry);
    for (const category of entry.categories) categories.set(category, [...(categories.get(category) ?? []), entry]);
  }
  return { before_exists: beforeExists, after_exists: afterExists, before_sha256: beforeExists ? hashFile(pathA) : null, after_sha256: afterExists ? hashFile(pathB) : null, equal: beforeExists && afterExists && beforeText === afterText, changed_entries: changed, categories: Object.fromEntries(categories) };
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
  const categories = {};
  for (const store of stores) {
    const presentA = storesA.includes(store);
    const presentB = storesB.includes(store);
    const artifacts = presentA && presentB ? [...new Set([...captureArtifacts(dirA, store), ...captureArtifacts(dirB, store)])] : [];
    const result = { ok: presentA && presentB && artifacts.length > 0, artifacts, files: {} };
    if (!presentA || !presentB) result.reason = 'store is present in only one directory';
    if (artifacts.length === 0) result.reason = result.reason ?? 'store has no retained artifacts';
    for (const artifact of artifacts) {
      const file = structuredFileDiff(store, artifact, join(dirA, store, artifact), join(dirB, store, artifact));
      result.files[artifact] = file;
      result.ok = file.equal && result.ok;
      if (!file.equal) changedFiles.push({ store, artifact, before_sha256: file.before_sha256, after_sha256: file.after_sha256, changed_entries: file.changed_entries });
      for (const [category, entries] of Object.entries(file.categories)) categories[category] = [...(categories[category] ?? []), ...entries];
    }
    perStore[store] = result;
  }
  return { stores: perStore, ok: Object.values(perStore).length > 0 && Object.values(perStore).every((result) => result.ok), diff: { changed_files: changedFiles, categories } };
}

function sameShape(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
  if (!artifact.stores || typeof artifact.stores !== 'object' || Array.isArray(artifact.stores)) errors.push('stores are missing');
  else {
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
        if (!file || typeof file !== 'object' || typeof file.equal !== 'boolean' || !Array.isArray(file.changed_entries) || !file.categories || typeof file.categories !== 'object' || Array.isArray(file.categories)) errors.push(`${store}/${artifactName} file evidence is malformed`);
        else for (const [category, entries] of Object.entries(file.categories)) if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object')) errors.push(`${store}/${artifactName} category ${category} is malformed`);
      }
    }
    const unknownStores = Object.keys(artifact.stores).filter((store) => !stores.includes(store));
    if (unknownStores.length > 0) errors.push(`unknown store evidence: ${unknownStores.join(', ')}`);
  }
  if (!artifact.diff || typeof artifact.diff !== 'object' || !Array.isArray(artifact.diff.changed_files) || !artifact.diff.categories || typeof artifact.diff.categories !== 'object' || Array.isArray(artifact.diff.categories)) errors.push('structured diff is missing changed_files or categories');
  else for (const [category, entries] of Object.entries(artifact.diff.categories)) if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object')) errors.push(`structured diff category ${category} is malformed`);
  if (paths.before && paths.after && artifact.stores && artifact.diff) {
    try {
      const recomputed = compareCaptureDirectories(paths.before, paths.after);
      if (!sameShape(artifact.stores, recomputed.stores)) errors.push('per-store evidence does not match retained captures');
      if (!sameShape(artifact.diff, recomputed.diff)) errors.push('structured diff does not match retained captures');
      if (artifact.ok !== recomputed.ok) errors.push(`ok ${artifact.ok} does not match retained captures (${recomputed.ok})`);
    } catch (error) {
      errors.push(`retained capture comparison failed: ${error.message}`);
    }
  }
  return errors;
}
