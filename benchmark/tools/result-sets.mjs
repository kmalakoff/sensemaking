#!/usr/bin/env node
// Capture exact ranked paths from every declared store on the same corpus/query/config/k. The
// overlap is descriptive evidence of selected-work divergence, never a correctness or timing gate.
// usage: node benchmark/tools/result-sets.mjs [corpus ...] [--queries lexical,words,default] [--k 10] [--out FILE]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import { STORE_NAMES, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from '../lib/corpus.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import { signalProcessTree } from '../lib/native-observer.mjs';
import { writeOut } from '../lib/out.mjs';
import { overlapByStore, queryDefinitions, RESULT_SET_QUERY_IDS, RESULT_SET_SCHEMA, resultSetWorkload, validateResultSetArtifact } from '../lib/result-sets.mjs';
import { captureFileManifest, ephemeralWorkTree, verifyManifestContents } from '../lib/work-tree.mjs';
import { identityHash, manifestIdentity } from '../lib/workload-identity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'cli.js');
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_CORPORA = ['obsidian-hub', 'obsidian-hub-x2', 'obsidian-hub-x4', 'stress'];
const CONFIG = {
  version: SUPPORTED_CONFIG_VERSION,
  presets: {
    default: { include: ['**/*.md'] },
    lexical: { include: ['**/*.md'], signals: { words: 1, links: 1 } },
    words: { include: ['**/*.md'], signals: { words: 1 } },
  },
  embed: { model: 'minishlab/potion-retrieval-32M', provider: 'static' },
  queries: {},
};

function usage() {
  console.error('usage: node benchmark/tools/result-sets.mjs [corpus ...] [--queries lexical,words,default] [--k 10] [--out FILE]');
  console.error(`all declared stores are required: ${STORE_NAMES.join(', ')}`);
}

let parsed;
try {
  parsed = parseArgs({ options: { queries: { type: 'string' }, k: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (parsed.values.help) {
  usage();
  process.exit(0);
}

const k = parsed.values.k === undefined ? 10 : Number(parsed.values.k);
if (!Number.isSafeInteger(k) || k < 1) {
  usage();
  console.error('--k must be a positive integer');
  process.exit(2);
}
const queryIds = (parsed.values.queries ?? RESULT_SET_QUERY_IDS.join(','))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
let queries;
try {
  queries = queryDefinitions(queryIds, k);
} catch (error) {
  usage();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const corpusArgs = parsed.positionals.length > 0 ? parsed.positionals : DEFAULT_CORPORA;
if (new Set(corpusArgs).size !== corpusArgs.length) {
  usage();
  console.error('corpus arguments must be unique');
  process.exit(2);
}

const logicalConfig = { version: CONFIG.version, presets: CONFIG.presets, embed: CONFIG.embed, queries: CONFIG.queries };
const stores = [...STORE_NAMES];

function runCli(cwd, argv) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [CLI, ...argv], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let failure = null;
    let finished = false;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const stop = (reason) => {
      failure ??= reason;
      if (!child.pid) return;
      try {
        signalProcessTree(child);
      } catch (error) {
        failure = `${failure}; process cleanup: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    const read = (which) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(`output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        return;
      }
      if (which === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on('data', read('stdout'));
    child.stderr.on('data', read('stderr'));
    child.once('error', (error) => {
      failure ??= `spawn error: ${error.message}`;
    });
    child.once('close', (status, signal) => finish({ status, signal, stdout, stderr, error: failure }));
    timer = setTimeout(() => stop(`timed out after ${TIMEOUT_MS}ms`), TIMEOUT_MS);
  });
}

function sourceFor(arg) {
  const source = CORPUS_NAMES.includes(arg) ? corpusPath(arg) : resolve(arg);
  if (!source || !existsSync(source)) throw new Error(`corpus does not exist: ${arg}`);
  return source;
}

function parseRows(stdout, expectedPaths, label, limit) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`${label} JSON output is not an array`);
  if (rows.length > limit) throw new Error(`${label} returned ${rows.length} rows, exceeding k=${limit}`);
  const paths = [];
  const seen = new Set();
  const resultRows = [];
  for (const [rank, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || typeof row.path !== 'string' || row.path.length === 0) throw new Error(`${label} row ${rank} has no nonempty string path`);
    if (seen.has(row.path)) throw new Error(`${label} returned duplicate path ${row.path}`);
    if (!expectedPaths.has(row.path)) throw new Error(`${label} returned path outside the corpus: ${row.path}`);
    if ('score' in row && row.score !== null && (typeof row.score !== 'number' || !Number.isFinite(row.score))) throw new Error(`${label} row ${rank} has an invalid score`);
    seen.add(row.path);
    paths.push(row.path);
    resultRows.push({ rank: rank + 1, path: row.path, score: row.score ?? null });
  }
  return { paths, rows: resultRows, fingerprint: identityHash(paths) };
}

async function captureCorpus(arg) {
  const sourceTree = sourceFor(arg);
  const manifest = captureFileManifest(sourceTree);
  const corpus = manifestIdentity(manifest, { includeMtime: true });
  const workload = resultSetWorkload({ corpus, queries, k, config: logicalConfig });
  const expectedPaths = new Set(manifest.map(({ rel }) => rel));
  const results = {};
  const errors = [];
  for (const store of stores) {
    let tree;
    try {
      tree = ephemeralWorkTree(join(ROOT, '.tmp'), `result-sets-${store}-`, sourceTree);
      writeTreeConfig(tree, CONFIG, { store });
      // cpSync can round a source mtime by a fractional millisecond on some filesystems. The
      // source manifest is the common logical identity; copied bytes and paths are what queries read.
      verifyManifestContents(captureFileManifest(tree), manifest, `${arg}/${store} copied corpus`);
      const queryResults = {};
      for (const query of queries) {
        const run = await runCli(tree, [...query.argv]);
        if (run.status !== 0 || run.signal || run.error) throw new Error(`${arg}/${store}/${query.id} failed: ${run.error ?? `exit ${run.status ?? 'null'}${run.signal ? ` (${run.signal})` : ''}: ${run.stderr.split('\n').find(Boolean) ?? 'no stderr'}`}`);
        queryResults[query.id] = parseRows(run.stdout, expectedPaths, `${arg}/${store}/${query.id}`, k);
      }
      results[store] = { workload_fingerprint: workload.fingerprint, queries: queryResults };
    } catch (error) {
      errors.push(`${arg}/${store}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (tree) {
        try {
          safeRmSync(tree, { recursive: true, force: true });
        } catch (error) {
          errors.push(`${arg}/${store}: cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  if (identityHash(Object.keys(results).sort()) !== identityHash(stores.slice().sort())) errors.push(`${arg}: missing one or more required store results`);
  for (const [store, result] of Object.entries(results)) if (result.workload_fingerprint !== workload.fingerprint) errors.push(`${arg}/${store}: workload identity differs from the common corpus/query/config/k identity`);
  const complete = errors.length === 0;
  return {
    source_tree: sourceTree,
    corpus,
    workload,
    stores: results,
    overlap: complete ? Object.fromEntries(queries.map((query) => [query.id, overlapByStore(Object.fromEntries(stores.map((store) => [store, results[store].queries[query.id]])), stores)])) : {},
    errors,
  };
}

const corpora = {};
const errors = [];
for (const arg of corpusArgs) {
  try {
    corpora[arg] = await captureCorpus(arg);
    errors.push(...corpora[arg].errors);
  } catch (error) {
    errors.push(`${arg}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const artifact = {
  schema: RESULT_SET_SCHEMA,
  measure_version: MEASURE_VERSION,
  package_version: PACKAGE_VERSION,
  status: errors.length === 0 ? 'success' : 'invalid',
  valid: errors.length === 0,
  stores,
  queries,
  k,
  config: logicalConfig,
  config_fingerprint: identityHash(logicalConfig),
  corpora,
  errors,
  scope: 'exact ranked path lists from each native store; pairwise overlap is descriptive selected-work evidence, not a correctness oracle, auto-repin rule, or performance gate',
};
const artifactErrors = validateResultSetArtifact(artifact, { measureVersion: MEASURE_VERSION, stores });
if (artifactErrors.length > 0) {
  artifact.valid = false;
  artifact.status = 'invalid';
  artifact.errors.push(...artifactErrors.filter((error) => !artifact.errors.includes(error)));
}
console.log(JSON.stringify(artifact, null, 2));
writeOut(parsed.values.out, artifact);
process.exitCode = artifact.valid ? 0 : 1;
