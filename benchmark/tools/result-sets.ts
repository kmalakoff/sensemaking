#!/usr/bin/env node
// Capture exact ranked paths from every declared store on the same corpus/query/config/k. The
// overlap is descriptive evidence of selected-work divergence, never a correctness or timing gate.
// usage: node benchmark/tools/result-sets.ts [corpus ...] [--queries lexical,words,default] [--k 10] [--out FILE]
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safeRmSync } from 'fs-remove-compat';
import type { Config } from 'sensemaking';
import { STORE_NAMES, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { CORPUS_NAMES, corpusPath, writeTreeConfig } from '../lib/corpus.ts';
import { MEASURE_VERSION } from '../lib/measure.ts';
import { writeOut } from '../lib/out.ts';
import { overlapByStore, queryDefinitions, RESULT_SET_QUERY_IDS, RESULT_SET_SCHEMA, resultSetWorkload, validateResultSetArtifact } from '../lib/result-sets.ts';
import { jobProblems, spawnOwned } from '../lib/step-process.ts';
import { captureFileManifest, ephemeralWorkTree, verifyManifestContents } from '../lib/work-tree.ts';
import { identityHash, manifestIdentity } from '../lib/workload-identity.ts';

interface CliResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'bin', 'cli.js');
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: unknown }).version;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_CORPORA = ['obsidian-hub', 'obsidian-hub-x2', 'obsidian-hub-x4', 'stress'];
const CONFIG: Config = {
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
  console.error('usage: node benchmark/tools/result-sets.ts [corpus ...] [--queries lexical,words,default] [--k 10] [--out FILE]');
  console.error(`all declared stores are required: ${STORE_NAMES.join(', ')}`);
}

let parsed: { values: { queries?: string; k?: string; out?: string; help?: boolean }; positionals: string[] };
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
let queries: ReturnType<typeof queryDefinitions>;
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

// Each CLI call is an owned job: its group, npm installs included, is released when it exits.
async function runCli(cwd: string, argv: string[]): Promise<CliResult> {
  const job = spawnOwned([process.execPath, CLI, ...argv], { cwd });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  const read = (which: 'stdout' | 'stderr') => (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) return job.fail(`output exceeded ${MAX_OUTPUT_BYTES} bytes`);
    if (which === 'stdout') stdout += chunk;
    else stderr += chunk;
  };
  job.stdout.on('data', read('stdout'));
  job.stderr.on('data', read('stderr'));
  const result = await job.result;
  const outcome = typeof result.command === 'object' ? result.command : { code: null, signal: null };
  const error = jobProblems(result).join('; ') || null;
  return { status: outcome.code, signal: outcome.signal, stdout, stderr, error };
}

function sourceFor(arg: string) {
  const source = CORPUS_NAMES.includes(arg) ? corpusPath(arg) : resolve(arg);
  if (!source || !existsSync(source)) throw new Error(`corpus does not exist: ${arg}`);
  return source;
}

function parseRows(stdout: string, expectedPaths: ReadonlySet<string>, label: string, limit: number) {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(rows)) throw new Error(`${label} JSON output is not an array`);
  if (rows.length > limit) throw new Error(`${label} returned ${rows.length} rows, exceeding k=${limit}`);
  const paths: string[] = [];
  const seen = new Set<string>();
  const resultRows: Array<{ rank: number; path: string; score: number | null }> = [];
  for (const [rank, row] of (rows as unknown[]).entries()) {
    if (!row || typeof row !== 'object' || typeof (row as { path?: unknown }).path !== 'string' || (row as { path: string }).path.length === 0) throw new Error(`${label} row ${rank} has no nonempty string path`);
    if (seen.has((row as { path: string }).path)) throw new Error(`${label} returned duplicate path ${(row as { path: string }).path}`);
    if (!expectedPaths.has((row as { path: string }).path)) throw new Error(`${label} returned path outside the corpus: ${(row as { path: string }).path}`);
    if ('score' in row && row.score !== null && (typeof row.score !== 'number' || !Number.isFinite(row.score))) throw new Error(`${label} row ${rank} has an invalid score`);
    seen.add((row as { path: string }).path);
    paths.push((row as { path: string }).path);
    resultRows.push({ rank: rank + 1, path: (row as { path: string }).path, score: (row as { score?: number | null }).score ?? null });
  }
  return { paths, rows: resultRows, fingerprint: identityHash(paths) };
}

async function captureCorpus(arg: string) {
  const sourceTree = sourceFor(arg);
  const manifest = captureFileManifest(sourceTree);
  const corpus = manifestIdentity(manifest, { includeMtime: true });
  const workload = resultSetWorkload({ corpus, queries, k, config: logicalConfig });
  const expectedPaths = new Set(manifest.map(({ rel }) => rel));
  const results: Record<string, { workload_fingerprint: string; queries: Record<string, ReturnType<typeof parseRows>> }> = {};
  const errors: string[] = [];
  for (const store of stores) {
    let tree: string | undefined;
    try {
      tree = ephemeralWorkTree(join(ROOT, '.tmp'), `result-sets-${store}-`, sourceTree);
      writeTreeConfig(tree, CONFIG, { store });
      // cpSync can round a source mtime by a fractional millisecond on some filesystems. The
      // source manifest is the common logical identity; copied bytes and paths are what queries read.
      verifyManifestContents(captureFileManifest(tree), manifest, `${arg}/${store} copied corpus`);
      const queryResults: Record<string, ReturnType<typeof parseRows>> = {};
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

const corpora: Record<string, Awaited<ReturnType<typeof captureCorpus>>> = {};
const errors: string[] = [];
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
