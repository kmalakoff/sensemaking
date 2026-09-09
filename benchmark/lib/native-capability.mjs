// Small native-store observations. These checks assert authored fixture properties; timing is
// reported for diagnostics only and never decides a benchmark row.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { safeRmSync } from 'fs-remove-compat';
import { MEASURE_VERSION, warmFileCache } from './measure.mjs';
import { identityHash, implementationProvenance, manifestIdentity } from './workload-identity.mjs';

export const DEFAULT_NATIVE_NOTES = 4;
export const DEFAULT_NATIVE_REPETITIONS = 3;
// This diagnostic is intentionally bounded, while still covering the existing 13k/26k corpus
// scales. Artifact consumers impose their own serialized-size limits.
export const MAX_NATIVE_NOTES = 50_000;
export const MAX_NATIVE_REPETITIONS = 100;
export const NATIVE_CAPABILITY_VECTOR_DIMS = 256;
export const NATIVE_CAPABILITY_SCHEMA = 'native-capability-v3';
export const NATIVE_CAPABILITY_CASES = ['baseline', 'large-content', 'dense-terms', 'broad-matches', 'top-one', 'narrow-vectors', 'structured-content'];
export const NATIVE_CAPABILITY_READINESS_POLICY = { method: 'os.loadavg[0] <= logical_cores / 2', max_load_per_logical_core: 0.5, unsupported_platforms: ['win32'] };
export const NATIVE_CAPABILITY_ROWS = ['open', 'cold_lexical', 'warm_lexical', 'content_read', 'vector_write', 'vector_candidates', 'vector_similar'];
export const NATIVE_CAPABILITY_HARNESS_FILES = [
  'benchmark/lib/canonical-json.mjs',
  'benchmark/lib/measure.mjs',
  'benchmark/lib/native-capability.mjs',
  'benchmark/lib/out.mjs',
  'benchmark/lib/quiet-machine.mjs',
  'benchmark/lib/require-build.mjs',
  'benchmark/lib/work-tree.mjs',
  'benchmark/lib/workload-identity.mjs',
  'benchmark/tools/native-capability.mjs',
];
const FIXTURE_MTIME_MS = Date.parse('2100-01-01T00:00:00.000Z');
const MODEL = 'minishlab/potion-retrieval-32M';
const DIAGONAL_SIMILARITY = Number(Math.SQRT1_2.toFixed(3));
const ONE_MIB = 1024 * 1024;
const LARGE_CONTENT_PREFIX = 'other delta ';
// The final newline is written by writeFixture: 12 prefix bytes + 1,048,563 x bytes + 1 newline = 1 MiB.
const LARGE_CONTENT_BODY = `${LARGE_CONTENT_PREFIX}${'x'.repeat(ONE_MIB - 1 - Buffer.byteLength(LARGE_CONTENT_PREFIX))}`;
// Eight literal query terms preserve the same two matching paths while increasing term density.
const DENSE_A = 'needle needle needle needle needle needle needle needle alpha';
const DENSE_B = 'needle needle needle needle needle needle needle needle beta';

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function assertNotes(notes) {
  if (!Number.isInteger(notes) || notes < DEFAULT_NATIVE_NOTES || notes > MAX_NATIVE_NOTES) throw new Error(`--notes must be an integer from ${DEFAULT_NATIVE_NOTES} to ${MAX_NATIVE_NOTES}`);
}

function noteSpecs(notes) {
  assertNotes(notes);
  const specs = [
    ['a.md', 'needle alpha'],
    ['b.md', 'needle beta'],
    ['c.md', 'other gamma'],
    ['d.md', `other delta ${Array.from({ length: 64 }, (_, i) => `large-${i}`).join(' ')}`],
  ];
  for (let i = 4; i < notes; i++) specs.push([`filler-${String(i - 3).padStart(3, '0')}.md`, `filler note ${i - 3}`]);
  return specs;
}

// A small structured lexical corpus. The vector tree deliberately stays on noteSpecs so this
// case exercises frontmatter/outline/link persistence without changing the vector geometry.
const STRUCTURED_LEXICAL_SPECS = [
  ['a.md', '---\ntitle: Alpha\nstatus: active\n---\n# Alpha\n\nneedle alpha\nSee [[b]].'],
  ['b.md', '---\ntitle: Beta\nstatus: active\n---\n## Beta\n\nneedle beta\nSee [[a]].'],
  ['c.md', '---\ntitle: Gamma\nstatus: archived\n---\n### Gamma\n\nother gamma'],
  ['d.md', '---\ntitle: Delta\nstatus: archived\n---\n#### Delta\n\nother delta'],
];

const STRUCTURED_CONTENT_ROWS = [
  { path: 'a.md', title_hash: identityHash('Alpha'), summary_hash: identityHash(''), text_hash: identityHash('Alpha needle alpha See b.') },
  { path: 'd.md', title_hash: identityHash('Delta'), summary_hash: identityHash(''), text_hash: identityHash('Delta other delta') },
];

const STRUCTURED_FACTS = {
  frontmatter: [
    { path: 'a.md', title: 'Alpha', status: 'active' },
    { path: 'b.md', title: 'Beta', status: 'active' },
    { path: 'c.md', title: 'Gamma', status: 'archived' },
    { path: 'd.md', title: 'Delta', status: 'archived' },
  ],
  sections: [
    { path: 'a.md', heading: 'Alpha', level: 1 },
    { path: 'b.md', heading: 'Beta', level: 2 },
    { path: 'c.md', heading: 'Gamma', level: 3 },
    { path: 'd.md', heading: 'Delta', level: 4 },
  ],
  links: [
    { src: 'a.md', target: 'b', dst: 'b.md', embed: 0 },
    { src: 'b.md', target: 'a', dst: 'a.md', embed: 0 },
  ],
};

function scenarioSpecs(caseId, notes) {
  const base = noteSpecs(notes);
  let lexical = base.map(([path, text]) => [path, text]);
  const vectors = base.map(([path, text]) => [path, text]);
  const axes = { notes, fixture_mtime_ms: FIXTURE_MTIME_MS, vector_wire_dims: NATIVE_CAPABILITY_VECTOR_DIMS, native_schema_dims: NATIVE_CAPABILITY_VECTOR_DIMS, candidate_k: 3, similar_k: 2 };
  if (caseId === 'large-content') lexical[3] = ['d.md', LARGE_CONTENT_BODY];
  if (caseId === 'dense-terms') {
    lexical[0] = ['a.md', DENSE_A];
    lexical[1] = ['b.md', DENSE_B];
  }
  if (caseId === 'broad-matches') {
    lexical[2] = ['c.md', `needle ${base[2][1]}`];
    lexical[3] = ['d.md', `needle ${base[3][1]}`];
  }
  if (caseId === 'top-one') {
    axes.candidate_k = 1;
    axes.similar_k = 1;
  }
  if (caseId === 'structured-content') lexical = [...STRUCTURED_LEXICAL_SPECS, ...base.slice(4)];
  if (caseId === 'narrow-vectors') axes.vector_wire_dims = 64;
  if (!NATIVE_CAPABILITY_CASES.includes(caseId)) throw new Error(`unknown native capability case ${caseId}; expected ${NATIVE_CAPABILITY_CASES.join(', ')}`);
  const baselineCandidates = [
    { path: 'a.md', similarity: 1 },
    { path: 'b.md', similarity: DIAGONAL_SIMILARITY },
    { path: 'c.md', similarity: 0 },
  ];
  const baselineSimilar = [
    { path: 'b.md', similarity: DIAGONAL_SIMILARITY },
    { path: 'c.md', similarity: 0 },
  ];
  return {
    case_id: caseId,
    axes,
    lexical,
    vectors,
    ...(caseId === 'structured-content' ? { structured: { content_rows: STRUCTURED_CONTENT_ROWS, facts: STRUCTURED_FACTS } } : {}),
    expected: {
      lexical_paths: caseId === 'broad-matches' ? ['a.md', 'b.md', 'c.md', 'd.md'] : ['a.md', 'b.md'],
      pending_before: vectors.map(([path]) => ({ path, chunk: 0 })),
      candidates: caseId === 'top-one' ? baselineCandidates.slice(0, 1) : baselineCandidates,
      similar: caseId === 'top-one' ? baselineSimilar.slice(0, 1) : baselineSimilar,
    },
  };
}

function writeFixture(baseDir, specs) {
  mkdirSync(baseDir, { recursive: true });
  for (const [path, text] of specs) {
    const absolute = join(baseDir, path);
    writeFileSync(absolute, `${text}\n`);
    utimesSync(absolute, FIXTURE_MTIME_MS / 1000, FIXTURE_MTIME_MS / 1000);
  }
  return specs;
}

function fileManifest(baseDir, specs) {
  return specs.map(([path]) => {
    const bytes = readFileSync(join(baseDir, path));
    const mtimeMs = statSync(join(baseDir, path)).mtimeMs;
    if (mtimeMs !== FIXTURE_MTIME_MS) throw new Error(`fixture mtime drifted for ${path}: expected ${FIXTURE_MTIME_MS}, got ${mtimeMs}`);
    return { rel: path, bytes: bytes.length, mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

function authoredManifest(specs) {
  return specs.map(([rel, text]) => ({ rel, bytes: Buffer.byteLength(`${text}\n`), mtimeMs: FIXTURE_MTIME_MS, sha256: createHash('sha256').update(`${text}\n`).digest('hex') }));
}

function assertPaths(actual, expected, label) {
  const paths = actual.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) throw new Error(`${label}: duplicate paths: ${paths.join(', ')}`);
  if (paths.slice().sort().join('\0') !== expected.slice().sort().join('\0')) throw new Error(`${label}: expected paths ${expected.join(', ')}, got ${paths.join(', ')}`);
}

function assertRows(actual, expected, label) {
  if (identityHash(actual.map(({ path, similarity }) => [path, similarity])) !== identityHash(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual.map(({ path, similarity }) => [path, similarity]))}`);
}

function assertPending(actual, expected, label) {
  if (actual.some(({ chunk }) => chunk !== 0)) throw new Error(`${label}: expected chunk 0 for every pending row`);
  assertPaths(actual, expected, label);
}

function assertManifest(actual, expected, label) {
  if (identityHash(actual) !== identityHash(expected)) throw new Error(`${label}: copied fixture differs from authored manifest`);
}

function vectorsFor(specs, storeDims) {
  return specs.map(([path], index) => {
    const vector = Buffer.alloc(storeDims);
    const first = index === 0 ? 127 : index === 1 ? 127 : index === 2 ? 0 : -127;
    const second = index === 1 ? 127 : index === 2 ? 127 : 0;
    vector.writeInt8(first, 0);
    vector.writeInt8(second, 1);
    const scale = index === 1 ? 1 / (Math.SQRT2 * 127) : 1 / 127;
    return { path, chunk: 0, scale, vector };
  });
}

function queryVectorIdentity(storeDims) {
  const query = new Float32Array(storeDims);
  query[0] = 1;
  return identityHash(Array.from(query));
}

export function nativeCapabilityEnvironment() {
  const processors = cpus();
  const machine = {
    hostname_sha256: identityHash(hostname()),
    platform: platform(),
    arch: arch(),
    release: release(),
    cpu_model: processors[0]?.model ?? 'unknown',
    logical_cores: processors.length,
    total_memory_bytes: totalmem(),
  };
  return { observation: 'runtime observation, not cryptographic attestation', machine, machine_fingerprint: identityHash(machine), runtime: { node: process.version } };
}

export function nativeCapabilityContract({ caseId = 'baseline', notes = DEFAULT_NATIVE_NOTES, repetitions = DEFAULT_NATIVE_REPETITIONS } = {}) {
  assertNotes(notes);
  if (!Number.isInteger(repetitions) || repetitions < DEFAULT_NATIVE_REPETITIONS || repetitions > MAX_NATIVE_REPETITIONS) throw new Error(`repetitions must be an integer from ${DEFAULT_NATIVE_REPETITIONS} to ${MAX_NATIVE_REPETITIONS}`);
  const scenario = scenarioSpecs(caseId, notes);
  const wireDims = scenario.axes.vector_wire_dims;
  const vectorInput = vectorsFor(scenario.vectors, wireDims).map(({ path, chunk, scale, vector }) => ({ path, chunk, scale, vector: vector.toString('hex') }));
  const corpus = { lexical: manifestIdentity(authoredManifest(scenario.lexical), { includeMtime: true }), vectors: manifestIdentity(authoredManifest(scenario.vectors), { includeMtime: true }) };
  const operation = {
    lexical: { query: 'needle', options: { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 }, config: { presets: { default: { include: ['**/*.md'] } }, embed: null } },
    content: {
      paths: ['a.md', 'd.md'],
      sql: scenario.structured ? 'SELECT "path", title, summary, text FROM content WHERE "path" = ?' : 'SELECT "path", text FROM content WHERE "path" = ?',
    },
    vectors: {
      dims: wireDims,
      wire_dims: wireDims,
      native_schema_dims: NATIVE_CAPABILITY_VECTOR_DIMS,
      input_identity: identityHash(vectorInput),
      query_identity: queryVectorIdentity(wireDims),
      seed: 'a.md',
      exclude: [],
      config: { presets: { default: { include: ['**/*.md'] } }, embed: { model: MODEL, provider: 'static' } },
      candidate_k: scenario.axes.candidate_k,
      similar_k: scenario.axes.similar_k,
    },
  };
  const requested = { case_id: caseId, notes, repetitions, vector_dims: wireDims, vector_wire_dims: wireDims, native_schema_dims: NATIVE_CAPABILITY_VECTOR_DIMS };
  const inputs = { case_id: caseId, axes: scenario.axes, corpus, operation, requested };
  return {
    scenario,
    inputs,
    fingerprint: identityHash(inputs),
    row_workload_ids: Object.fromEntries(NATIVE_CAPABILITY_ROWS.map((row) => [row, identityHash({ corpus, operation, requested, row })])),
    expected: {
      lexical_paths: scenario.expected.lexical_paths,
      content_rows: scenario.structured?.content_rows ?? ['a.md', 'd.md'].map((path) => ({ path, text_hash: identityHash(new Map(scenario.lexical).get(path)) })),
      pending_before: scenario.vectors.map(([path]) => ({ path, chunk: 0 })),
      candidates: scenario.expected.candidates,
      similar: scenario.expected.similar,
      ...(scenario.structured ? { structured: scenario.structured.facts } : {}),
    },
  };
}

const stableImplementationObservation = (provenance, environment) => ({
  measured_package: provenance.measured_package,
  harness: provenance.harness,
  runtime: provenance.runtime,
  native_package: provenance.native.package,
  environment,
});

async function withOpened(open, cfg, label, fn) {
  let opened;
  let primaryError;
  let result;
  const openStarted = performance.now();
  let openMs;
  try {
    opened = await open(cfg);
    openMs = performance.now() - openStarted;
    if (opened.store.name !== cfg.store) throw new Error(`opened store is ${opened.store.name}, expected ${cfg.store}`);
    result = await fn(opened.store, opened);
  } catch (error) {
    primaryError = error;
  }
  let closeError;
  if (opened) {
    try {
      await opened.store.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (primaryError || closeError) {
    const details = [primaryError ? `${label}: ${errorText(primaryError)}` : null, closeError ? `${label} cleanup: ${errorText(closeError)}` : null].filter(Boolean).join('; ');
    throw new Error(details, { cause: primaryError ?? closeError });
  }
  return { result, open_ms: openMs };
}

async function nativeFacts(store, storeName) {
  const sql = storeName === 'duckdb' ? 'SELECT version() AS version' : 'SELECT sqlite_version() AS version';
  const version = await (await store.prepare(sql)).get();
  return { version_query: sql, capabilities: [...store.capabilities], engine_status: await store.engineStatus(), version: version?.version ?? null };
}

async function structuredFacts(store, scenario, storeName) {
  if (!scenario.structured) return undefined;
  const paths = STRUCTURED_LEXICAL_SPECS.map(([path]) => path);
  const placeholders = paths.map(() => '?').join(', ');
  const frontmatter = await (await store.prepare(`SELECT "path", title, status FROM frontmatter WHERE "path" IN (${placeholders}) ORDER BY "path"`)).all(...paths);
  const sections = await (await store.prepare(`SELECT "path", heading, level FROM sections WHERE "path" IN (${placeholders}) ORDER BY "path", idx`)).all(...paths);
  const links = await (await store.prepare(`SELECT src, target, dst, embed FROM links WHERE src IN (${placeholders}) ORDER BY src, target, embed`)).all(...paths);
  const facts = {
    frontmatter: frontmatter.map(({ path, title, status }) => ({ path, title, status })),
    sections: sections.map(({ path, heading, level }) => ({ path, heading, level: Number(level) })),
    links: links.map(({ src, target, dst, embed }) => ({ src, target, dst, embed: Number(embed) })),
  };
  if (identityHash(facts) !== identityHash(scenario.structured.facts)) throw new Error(`${storeName} structured facts differ from authored expectations`);
  return facts;
}

async function observeTree({ open, storeName, baseDir, scenario }) {
  const lexicalDir = join(baseDir, 'lexical');
  const vectorDir = join(baseDir, 'vectors');
  const lexicalSpecs = writeFixture(lexicalDir, scenario.lexical);
  const vectorSpecs = writeFixture(vectorDir, scenario.vectors);
  const lexicalManifest = fileManifest(lexicalDir, lexicalSpecs);
  const vectorManifest = fileManifest(vectorDir, vectorSpecs);
  assertManifest(lexicalManifest, authoredManifest(lexicalSpecs), `${storeName} lexical manifest`);
  assertManifest(vectorManifest, authoredManifest(vectorSpecs), `${storeName} vector manifest`);
  warmFileCache(lexicalDir);
  warmFileCache(vectorDir);
  const lexicalCfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: lexicalDir, configPath: null, store: storeName };
  const vectorCfg = { ...lexicalCfg, baseDir: vectorDir, embed: { model: MODEL, provider: 'static' } };
  const lexicalRun = await withOpened(open, lexicalCfg, `${storeName} lexical`, async (store) => {
    const firstStarted = performance.now();
    const first = await store.lexical.query('needle', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
    const firstMs = performance.now() - firstStarted;
    assertPaths(first, scenario.expected.lexical_paths, `${storeName} cold lexical`);
    const warmStarted = performance.now();
    const warm = await store.lexical.query('needle', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
    const warmMs = performance.now() - warmStarted;
    assertPaths(warm, scenario.expected.lexical_paths, `${storeName} warm lexical`);
    return { first_ms: firstMs, warm_ms: warmMs, first_paths: first.map(({ path }) => path), warm_paths: warm.map(({ path }) => path), output_hash: identityHash({ first, warm }), native: await nativeFacts(store, storeName) };
  });
  const lexical = lexicalRun.result;
  const vectorRows = vectorsFor(vectorSpecs, scenario.axes.vector_wire_dims);
  const queryVector = new Float32Array(scenario.axes.vector_wire_dims);
  queryVector[0] = 1;
  const vectorRun = await withOpened(open, vectorCfg, `${storeName} vectors`, async (store) => {
    const pendingBefore = await store.vectors.pending();
    assertPending(
      pendingBefore,
      scenario.expected.pending_before.map(({ path }) => path),
      `${storeName} pending before write`
    );
    const writeStarted = performance.now();
    await store.vectors.writeVectors(vectorRows);
    const writeMs = performance.now() - writeStarted;
    const pendingAfter = await store.vectors.pending();
    if (pendingAfter.length !== 0) throw new Error(`vector write left ${pendingAfter.length} pending rows`);
    const candidateStarted = performance.now();
    const candidates = await store.vectors.candidates(queryVector, scenario.axes.vector_wire_dims, scenario.axes.candidate_k);
    const candidateMs = performance.now() - candidateStarted;
    assertPaths(
      candidates,
      scenario.expected.candidates.map(({ path }) => path),
      `${storeName} vector candidates`
    );
    assertRows(
      candidates,
      scenario.expected.candidates.map(({ path, similarity }) => [path, similarity]),
      `${storeName} vector candidates`
    );
    const similarStarted = performance.now();
    const similar = await store.vectors.similar('a.md', { exclude: new Set(), k: scenario.axes.similar_k });
    const similarMs = performance.now() - similarStarted;
    assertPaths(
      similar,
      scenario.expected.similar.map(({ path }) => path),
      `${storeName} vector similar`
    );
    assertRows(
      similar,
      scenario.expected.similar.map(({ path, similarity }) => [path, similarity]),
      `${storeName} vector similar`
    );
    const candidateEvidence = candidates.map(({ path, similarity }) => ({ path, similarity }));
    const similarEvidence = similar.map(({ path, similarity }) => ({ path, similarity }));
    return {
      write_ms: writeMs,
      candidates_ms: candidateMs,
      similar_ms: similarMs,
      pending_before: pendingBefore,
      pending_after: pendingAfter,
      candidates: candidateEvidence,
      similar: similarEvidence,
      output_hash: identityHash({ candidates: candidateEvidence, similar: similarEvidence }),
      native: await nativeFacts(store, storeName),
    };
  });
  const vectors = vectorRun.result;
  const contentRun = await withOpened(open, lexicalCfg, `${storeName} content`, async (store) => {
    const structured = Boolean(scenario.structured);
    const statement = await store.prepare(structured ? 'SELECT "path", title, summary, text FROM content WHERE "path" = ?' : 'SELECT "path", text FROM content WHERE "path" = ?');
    const expected = scenario.structured?.content_rows ?? ['a.md', 'd.md'].map((path) => ({ path, text_hash: identityHash(new Map(lexicalSpecs).get(path)) }));
    const rows = [];
    const started = performance.now();
    const rawRows = [];
    for (const path of ['a.md', 'd.md']) rawRows.push(await statement.get(path));
    const readMs = performance.now() - started;
    for (const [index, row] of rawRows.entries()) {
      const path = ['a.md', 'd.md'][index];
      if (!row || row.path !== path) throw new Error(`content row did not preserve authored prose for ${path}`);
      const actual = structured ? { path, title_hash: identityHash(row.title), summary_hash: identityHash(row.summary), text_hash: identityHash(row.text) } : { path, text_hash: identityHash(row.text) };
      if (identityHash(actual) !== identityHash(expected.find(({ path: expectedPath }) => expectedPath === path))) throw new Error(`content row did not preserve parsed authored values for ${path}`);
      rows.push(actual);
    }
    return { ms: readMs, paths: rows.map(({ path }) => path), rows, output_hash: identityHash(rows) };
  });
  const content = contentRun.result;
  // Structured metadata is deliberately observed after every timed lexical/content operation;
  // its SQL checks are correctness postconditions, not another timed native workload row.
  const structuredRun = scenario.structured ? await withOpened(open, lexicalCfg, `${storeName} structured`, async (store) => structuredFacts(store, scenario, storeName)) : undefined;
  return {
    open_ms: lexicalRun.open_ms,
    lexical: { open_ms: lexicalRun.open_ms, first_ms: lexical.first_ms, warm_ms: lexical.warm_ms, first_paths: lexical.first_paths, warm_paths: lexical.warm_paths, output_hash: lexical.output_hash },
    content: { ...content, open_ms: contentRun.open_ms },
    vectors: { ...vectors, open_ms: vectorRun.open_ms },
    ...(scenario.structured ? { structured: structuredRun?.result } : {}),
    manifests: { lexical: manifestIdentity(lexicalManifest, { includeMtime: true }), vectors: manifestIdentity(vectorManifest, { includeMtime: true }) },
    native: lexical.native,
    vector_native: vectors.native,
  };
}

export async function runNativeCapability({
  open,
  store,
  storeNames,
  root,
  packageRoot,
  harnessRoot = packageRoot,
  harnessFiles = NATIVE_CAPABILITY_HARNESS_FILES,
  storeDims = NATIVE_CAPABILITY_VECTOR_DIMS,
  notes = DEFAULT_NATIVE_NOTES,
  repetitions = DEFAULT_NATIVE_REPETITIONS,
  caseId = 'baseline',
  environmentBefore: suppliedEnvironmentBefore = undefined,
}) {
  if (!Array.isArray(storeNames) || !storeNames.includes(store)) throw new Error(`unknown --store ${store}; expected ${storeNames?.join(', ') ?? 'the built public store list'}`);
  assertNotes(notes);
  if (!Number.isInteger(repetitions) || repetitions < DEFAULT_NATIVE_REPETITIONS || repetitions > MAX_NATIVE_REPETITIONS) throw new Error(`repetitions must be an integer from ${DEFAULT_NATIVE_REPETITIONS} to ${MAX_NATIVE_REPETITIONS}`);
  if (storeDims !== NATIVE_CAPABILITY_VECTOR_DIMS) throw new Error(`native schema dimensions must be ${NATIVE_CAPABILITY_VECTOR_DIMS} for ${NATIVE_CAPABILITY_SCHEMA}`);
  const contract = nativeCapabilityContract({ caseId, notes, repetitions });
  const environmentBefore = suppliedEnvironmentBefore ?? nativeCapabilityEnvironment();
  const measuredEnvironmentBefore = nativeCapabilityEnvironment();
  const provenanceBefore = implementationProvenance({ packageRoot, harnessRoot, harnessFiles, store, nativeObservation: { status: 'deferred until native open' }, modelObservation: { status: 'configured_not_constructed', requested: MODEL, resolved_identity: 'not-observed' } });
  const implementationBefore = stableImplementationObservation(provenanceBefore, environmentBefore);
  const samples = [];
  const errors = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    const tree = mkdtempSync(join(root, `native-capability-${store}-${caseId}-`));
    let observation;
    let primaryError;
    let cleanupError;
    try {
      observation = await observeTree({ open, storeName: store, baseDir: tree, scenario: contract.scenario });
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        safeRmSync(tree, { recursive: true, force: true });
        if (existsSync(tree)) cleanupError = new Error(`temporary tree remains: ${tree}`);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError || cleanupError) {
      const details = [primaryError ? errorText(primaryError) : null, cleanupError ? `cleanup: ${errorText(cleanupError)}` : null].filter(Boolean).join('; ');
      samples.push({ repetition: repetition + 1, state: { tree: 'fresh', source_cache: 'warm', index: 'cold' }, error: details });
      errors.push(details);
      break;
    }
    samples.push({ repetition: repetition + 1, state: { tree: 'fresh', source_cache: 'warm', index: 'cold' }, ...observation });
  }
  const provenanceAfter = implementationProvenance({ packageRoot, harnessRoot, harnessFiles, store, nativeObservation: samples.find(({ native }) => native)?.native ?? { status: 'unobserved' }, modelObservation: { status: 'configured_not_constructed', requested: MODEL, resolved_identity: 'not-observed' } });
  const environmentAfter = nativeCapabilityEnvironment();
  if (identityHash(measuredEnvironmentBefore) !== identityHash(environmentBefore)) errors.push('readiness environment changed before native capability measurement');
  if (identityHash(environmentBefore) !== identityHash(environmentAfter)) errors.push('machine/runtime environment changed during native capability measurement');
  const implementationAfter = stableImplementationObservation(provenanceAfter, environmentAfter);
  const implementationStable = identityHash(implementationBefore) === identityHash(implementationAfter);
  if (!implementationStable) errors.push('implementation identity changed during native capability measurement');
  return {
    schema: NATIVE_CAPABILITY_SCHEMA,
    measure_version: MEASURE_VERSION,
    status: errors.length === 0 ? 'success' : 'invalid-measurement',
    store,
    case_id: caseId,
    notes,
    repetitions,
    valid: errors.length === 0,
    errors,
    samples,
    environment: environmentAfter,
    implementation_stability: { stable: implementationStable, before: implementationBefore, after: implementationAfter },
    workload: { fingerprint: contract.fingerprint, inputs: contract.inputs },
    row_workload_ids: contract.row_workload_ids,
    provenance: provenanceAfter,
  };
}
