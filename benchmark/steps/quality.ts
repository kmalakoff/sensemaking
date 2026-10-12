// Retrieval quality in three passes (bm25-only, fused, semantic) plus a hidden guard pass: a vectors-free preset must be row-identical to `fused`. Paired deltas with a sign-test z.
// usage: node benchmark/steps/quality.ts [corpus] [--queries N] [--k N] [--split test|dev] [--store name] [--query-form or-bag|bare-and] [--out file]
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { writeFileAtomic } from '../../dist/esm/lib/atomic-write.js';
import type { ResolvedConfig, Store } from '../../src/index.ts';
import { corpusLabels, corpusPath } from '../lib/corpus.ts';
import { readLabels } from '../lib/labels.ts';
import { MEASURE_VERSION } from '../lib/measure.ts';
import type { QualityMetrics } from '../lib/metrics.ts';
import { mean } from '../lib/metrics.ts';
import { buildQualityArtifactBase, evaluateVariant, qualityVariantEvidence, queryFormFor } from '../lib/quality.ts';
import { qualityRetrievalIdentity } from '../lib/quality-retrieval-identity.ts';
import { observeQualityModel, prepareQualityModel, prepareQualityWorkTree } from '../lib/quality-work-tree.ts';
import { mdTable } from '../lib/render.ts';
import { ROWS } from '../lib/rows.ts';
import { executionEvidence, identityHash, implementationProvenance, logicalConfig, logicalWorkloadIdentity, manifestIdentity } from '../lib/workload-identity.ts';

type Library = typeof import('../../src/index.ts');
type Work = ReturnType<typeof prepareQualityWorkTree>;
type Measured = Awaited<ReturnType<typeof evaluateVariant>>;
type Embed = Parameters<typeof prepareQualityModel>[1];
type ModelObservation = Awaited<ReturnType<typeof observeQualityModel>>;
type PublishedCache = ReturnType<Work['publish']> & { model_after_run: ModelObservation };
type UnpublishedCache = Record<string, unknown> & { status: string; reason: string; model_after_run: ModelObservation };
interface Variant {
  name: string;
  features?: ResolvedConfig['features'];
  embed: boolean;
  semanticOff: boolean;
  hidden?: boolean;
}
interface VariantResult extends Variant {
  execution: ReturnType<typeof executionEvidence> & { invocation_kind: string };
  model_observation: unknown;
  workload_identity: ReturnType<typeof logicalWorkloadIdentity>;
  perQuery: Measured['perQuery'];
  incomplete: boolean;
  ms: number | null;
  errors: number;
  error_details: { qid: string | null; error: string }[];
}

const { values: flags, positionals } = parseArgs({
  options: {
    queries: { type: 'string' },
    k: { type: 'string' },
    split: { type: 'string' },
    store: { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    url: { type: 'string' },
    'query-form': { type: 'string' },
  },
  allowPositionals: true,
});
const corpus = positionals[0] ?? 'nfcorpus';
const flag = <T>(name: keyof typeof flags, dflt: T): string | T => flags[name] ?? dflt;
const K = Number(flag('k', 10));
const MAX_QUERIES = Number(flag('queries', Infinity));
const SPLIT = flag('split', 'test');
const QUERY_FORM = flag('query-form', 'or-bag');
const queryFor = queryFormFor(QUERY_FORM);
if (!Number.isSafeInteger(K) || K < 1) {
  console.error('--k must be a positive integer');
  process.exit(2);
}
if (flags.queries !== undefined && (!Number.isSafeInteger(MAX_QUERIES) || MAX_QUERIES < 1)) {
  console.error('--queries must be a positive integer');
  process.exit(2);
}
if (queryFor === null) {
  console.error('--query-form must be or-bag or bare-and');
  process.exit(2);
}
// Retrieval quality uses common qrels, so metrics are comparable across stores when they support
// the same query form. The historical OR-bag form remains SQLite-only in practice because DuckDB
// and Turso reject its FTS5 syntax; use bare-and for the portable track.
// Omitted, this measures the default store, matching every recorded baseline in benchmark/reports.
const STORE = flag('store', undefined);
const outArg = flag('out', null);

function writeOut(path: string | null | undefined, artifact: unknown) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const source = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!source || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}
const lib: Library = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const { queries, qrels } = readLabels(labelsDir, SPLIT);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);
let tree: string | null = null;
let cacheState: Record<string, unknown> | null = null;

const baseArtifact = () => ({ ...buildQualityArtifactBase({ corpus, split: SPLIT, qids, k: K, store: STORE ?? 'sqlite', source, tree, measureVersion: MEASURE_VERSION, queries, qrels, queryForm: QUERY_FORM, queryFor }), cache: cacheState });
if (qids.length === 0) {
  writeOut(outArg, { ...baseArtifact(), incomplete: true, error: 'zero qids: no labeled queries selected' });
  console.error('zero qids: no labeled queries selected');
  process.exit(1);
}

// embed false -> vectors-free signals map (vectors never built); embed true -> config names the model and vectors build lazily on the first participating call. Without an embed block, the semantic pass silently measures lexical.
// --model/--provider/--url let a non-default corpus (e.g. an HTTP encoder over Ollama) reuse this real search()-through-chunk() path instead of bakeoff's whole-document scoring.
const EMBED: Embed & { url?: string } = { model: flag('model', 'minishlab/potion-retrieval-32M'), provider: flag('provider', 'static') as Embed['provider'], url: flag('url', undefined) };
const safeInvocationArgs = (args: readonly string[]) => args.map((arg, index) => (arg === '--url' || args[index - 1] === '--url' ? (arg === '--url' ? arg : '<redacted>') : arg.startsWith('--url=') ? '--url=<redacted>' : arg));
// There is no per-call semantic option: the preset decides. `semanticOff` writes a vectors-free `signals` weight map into the preset.
// That's the one lever the no-silent-change contract is about.
const VARIANTS: Variant[] = [
  { name: 'bm25-only', features: { links: false, rank: false }, embed: false, semanticOff: true },
  { name: 'fused', features: undefined, embed: false, semanticOff: true },
  { name: 'fused-embed-configured', features: undefined, embed: true, semanticOff: true, hidden: true }, // guard only
  { name: 'semantic', features: undefined, embed: true, semanticOff: false },
];

const configFor = (variant: Variant, baseDir: string): ResolvedConfig => ({
  presets: { default: { include: ['**/*.md'], ...(variant.semanticOff ? { signals: variant.features?.links === false ? { words: 1 } : { words: 1, links: 1 } } : {}) } },
  ...(variant.embed ? { embed: EMBED } : {}),
  features: variant.features,
  queries: {},
  baseDir,
  configPath: null,
  ...(STORE ? { store: STORE as ResolvedConfig['store'] } : {}),
});
await prepareQualityModel(ROOT, EMBED);
const modelObservation = await observeQualityModel(ROOT, EMBED);
const provenanceFor = (model: Awaited<ReturnType<typeof observeQualityModel>>) =>
  implementationProvenance({
    packageRoot: ROOT,
    harnessRoot: ROOT,
    harnessFiles: ['benchmark/steps/quality.ts', 'benchmark/lib/quality.ts', 'benchmark/lib/quality-work-tree.ts', 'benchmark/lib/workload-identity.ts'],
    store: STORE ?? 'sqlite',
    nativeObservation: { function: 'not queried by quality cache preflight', value: 'unobserved', status: null, error: null },
    modelObservation: model,
  });
const cacheInputsFor = (model: Awaited<ReturnType<typeof observeQualityModel>>) => {
  const provenance = provenanceFor(model);
  return {
    version: 1,
    configs: VARIANTS.map((variant) => ({ name: variant.name, config: executionEvidence({ argv: [], config: configFor(variant, '<private-tree>') }).config })),
    implementation: { measured_package: provenance.measured_package, runtime: provenance.runtime, native: provenance.native, harness: provenance.harness },
    retrieval: qualityRetrievalIdentity(ROOT),
    model,
  };
};
const initialCacheInputs = cacheInputsFor(modelObservation);
let qualityWork: Work | undefined;
try {
  qualityWork = prepareQualityWorkTree({ workRoot: join(ROOT, '.tmp', 'eval-work'), key: `${corpus}-${STORE ?? 'sqlite'}`, source, cacheInputs: initialCacheInputs, reuseEligible: modelObservation.reuse_eligible });
  tree = qualityWork.tree;
  cacheState = { cache_fingerprint: qualityWork.cacheFingerprint, cache_inputs: qualityWork.cacheInputs, copied_state: qualityWork.copied_state, reuse_state: qualityWork.reuse_state, reused_generation: qualityWork.reused_generation };
} catch (err) {
  cacheState = { status: 'preflight-failed', error: (err as { message?: unknown } | null | undefined)?.message ?? String(err) };
  writeOut(outArg, { ...baseArtifact(), incomplete: true, error: `quality cache preflight failed: ${cacheState.error}` });
  console.error(`quality cache preflight failed: ${cacheState.error}`);
  process.exitCode = 1;
}

/** @param {ReturnType<typeof prepareQualityWorkTree>} work */
async function runQuality(work: Work) {
  let settled = false;
  let primaryError: unknown = null;
  const results: VariantResult[] = [];
  const qualityArtifact = (extra: Record<string, unknown> = {}) => ({
    ...baseArtifact(),
    incomplete: true,
    ...extra,
    variants: Object.fromEntries(results.map((r) => [r.name, qualityVariantEvidence(r)])),
  });
  try {
    for (const variant of VARIANTS) {
      const cfg = configFor(variant, tree as string);
      const passStarted = process.hrtime.bigint();
      const pass = results.length + 1;
      const progress = (phase: string, extra: object = {}) => console.log(`quality-progress: ${JSON.stringify({ variant: variant.name, pass, passes: VARIANTS.length, phase, elapsed_ms: Number(process.hrtime.bigint() - passStarted) / 1e6, ...extra })}`);
      const errorDetails: { qid: string | null; error: string }[] = [];
      let storeHandle: Store | null = null;
      let measured: Measured | null = null;
      try {
        progress('open-start');
        const opened = await lib.open(cfg);
        storeHandle = opened.store;
        progress('open-end');
        measured = await evaluateVariant({ qids, queries, qrels, k: K, search: (terms, options) => lib.search(storeHandle as Store, cfg, terms, options), queryFor: queryFor as NonNullable<typeof queryFor>, onProgress: (counts) => progress('queries', counts) });
        errorDetails.push(...measured.errorDetails);
      } catch (err) {
        errorDetails.push({ qid: null, error: `open: ${(err as { name?: unknown } | null | undefined)?.name ?? 'Error'}: ${(err as { message?: unknown } | null | undefined)?.message ?? err}` });
      } finally {
        if (storeHandle) {
          try {
            progress('close-start');
          } catch (err) {
            errorDetails.push({ qid: null, error: `progress: ${(err as { name?: unknown } | null | undefined)?.name ?? 'Error'}: ${(err as { message?: unknown } | null | undefined)?.message ?? err}` });
          }
          try {
            await storeHandle.close();
            progress('close-end');
          } catch (err) {
            errorDetails.push({ qid: null, error: `close: ${(err as { name?: unknown } | null | undefined)?.name ?? 'Error'}: ${(err as { message?: unknown } | null | undefined)?.message ?? err}` });
          }
        }
      }
      results.push({
        ...variant,
        execution: { ...executionEvidence({ argv: safeInvocationArgs(process.argv.slice(2)), config: cfg }), invocation_kind: 'requested invocation projection' },
        model_observation: variant.embed ? { provider: EMBED.provider, model: EMBED.model, revision: 'unknown', resolved_identity: 'unverified' } : { status: 'not-applicable' },
        workload_identity: logicalWorkloadIdentity({
          corpus: manifestIdentity(work.sourceManifest),
          operation: { kind: 'quality', corpus, split: SPLIT, k: K, query_form: QUERY_FORM, query_evidence: baseArtifact().query_evidence, qrels: baseArtifact().qrels },
          requested: { variant: variant.name, config: logicalConfig(executionEvidence({ argv: [], config: cfg }).config), model: variant.embed ? modelObservation : { status: 'not-applicable' } },
        }),
        ...(measured ?? { perQuery: new Map<string, NonNullable<ReturnType<Measured['perQuery']['get']>>>(), incomplete: true, ms: null }),
        errors: errorDetails.length,
        error_details: errorDetails,
      });
      if (errorDetails.length > 0 || (results.at(-1) as VariantResult).incomplete) break;
      // A closed pass is useful evidence, but all four passes and final guards still own completion.
      if (Number.isFinite((results.at(-1) as VariantResult).ms)) {
        writeOut(outArg, qualityArtifact({ incomplete: true, completed_passes: results.map((result) => result.name) }));
        progress('checkpoint', { completed_passes: results.length });
      }
    }

    const invalidResults = results.filter((r) => r.errors > 0 || r.incomplete || !Number.isFinite(r.ms));
    if (invalidResults.length > 0) {
      const error = invalidResults.map((r) => `${r.name}: ${r.error_details.map((e) => `${e.qid ?? 'artifact'}: ${e.error}`).join('; ') || 'incomplete artifact'}`).join(' | ');
      writeOut(outArg, qualityArtifact({ incomplete: true, error }));
      console.error(`quality retrieval failed: ${error}`);
      process.exitCode = 1;
      return;
    }

    // Guard first: a semantic:false preset must fully disable vector participation, even on an embed-configured corpus.
    // fused-embed-configured must not diverge from fused by a single row.
    const fused = results.find((r) => r.name === 'fused') as VariantResult;
    const fusedEmbedConfigured = results.find((r) => r.name === 'fused-embed-configured') as VariantResult;
    const divergent = qids.filter((qid) => fused.perQuery.get(qid)?.rows !== fusedEmbedConfigured.perQuery.get(qid)?.rows);
    if (divergent.length > 0) {
      writeOut(outArg, qualityArtifact({ error: `NO-SILENT-CHANGE VIOLATION: ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})` }));
      console.error(`NO-SILENT-CHANGE VIOLATION: semantic:false didn't fully disable vectors on the embed-configured corpus -- ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})`);
      process.exitCode = 1;
      return;
    }
    console.log(`no-silent-change: ok — semantic:false on an embed-configured corpus is row-identical to fused (vectors never built) across ${qids.length} queries\n`);

    const aggregate = (result: VariantResult) => mean(qids.map((qid) => (result.perQuery.get(qid) as { m: QualityMetrics }).m));
    const shown = results.filter((r) => !r.hidden);
    const aggregates = new Map(shown.map((result) => [result.name, aggregate(result)]));
    const qualityRows = ROWS.filter((row) => row.kind === 'quality');
    console.log(`corpus: ${corpus} | split: ${SPLIT} | queries: ${qids.length} | k: ${K} | query form: ${QUERY_FORM}\n`);
    console.log(mdTable(['metric', ...shown.map((r) => r.name)], [...qualityRows.map((row) => [row.label, ...shown.map((r) => (aggregates.get(r.name) as QualityMetrics)[row.key as keyof QualityMetrics].toFixed(4))]), ['mean ms/query', ...shown.map((r) => (r.ms as number).toFixed(1))]]));

    // Paired per-query deltas between adjacent pairs of interest.
    function paired(a: VariantResult, b: VariantResult, key: keyof QualityMetrics) {
      let wins = 0;
      let losses = 0;
      for (const qid of qids) {
        const d = (b.perQuery.get(qid)?.m[key] ?? 0) - (a.perQuery.get(qid)?.m[key] ?? 0);
        if (d > 1e-12) wins++;
        else if (d < -1e-12) losses++;
      }
      const n = wins + losses;
      const z = n > 0 ? (wins - losses) / Math.sqrt(n) : 0;
      return { wins, losses, z };
    }
    const bm25 = results.find((r) => r.name === 'bm25-only') as VariantResult;
    const semantic = results.find((r) => r.name === 'semantic') as VariantResult;
    console.log('\npaired per-query deltas (wins/losses, sign-test z; |z| > 2 is beyond noise):');
    const pairedOut: Record<string, { ndcg: ReturnType<typeof paired>; hit: ReturnType<typeof paired> }> = {};
    for (const [label, key, a, b] of [
      ['fused vs bm25-only', 'fused_vs_bm25', bm25, fused],
      ['semantic vs fused', 'semantic_vs_fused', fused, semantic],
    ] as const) {
      const nd = paired(a, b, 'ndcg');
      const h = paired(a, b, 'hit');
      console.log(`- ${label}: nDCG ${nd.wins}W/${nd.losses}L z=${nd.z.toFixed(1)} · hit ${h.wins}W/${h.losses}L z=${h.z.toFixed(1)}`);
      pairedOut[key] = { ndcg: nd, hit: h };
    }
    const errTotal = results.filter((r) => r.errors > 0);
    if (errTotal.length > 0) console.log(`\nerrors: ${errTotal.map((r) => `${r.name}=${r.errors}`).join(', ')}`);

    let cacheEvidence: PublishedCache | UnpublishedCache;
    const modelAfterRun = await observeQualityModel(ROOT, EMBED);
    const finalCacheInputs = cacheInputsFor(modelAfterRun);
    if (identityHash(finalCacheInputs) === identityHash(initialCacheInputs)) {
      cacheEvidence = { ...work.publish(), model_after_run: modelAfterRun };
      settled = true;
      tree = cacheEvidence.tree;
      cacheState = cacheEvidence;
    } else {
      work.discard();
      settled = true;
      cacheEvidence = { ...cacheState, status: 'not-published', reason: 'cache identity changed during the run', model_after_run: modelAfterRun };
      cacheState = cacheEvidence;
      const error = 'quality cache identity changed during the run; measurement is invalid';
      writeOut(outArg, qualityArtifact({ incomplete: true, error }));
      console.error(error);
      process.exitCode = 1;
      return;
    }

    writeOut(outArg, {
      ...baseArtifact(),
      incomplete: false,
      no_silent_change: true,
      variants: Object.fromEntries(shown.map((r) => [r.name, { ...aggregates.get(r.name), ...qualityVariantEvidence(r) }])),
      paired: pairedOut,
      cache: cacheEvidence,
    });
  } catch (err) {
    primaryError = err;
    cacheState = { ...cacheState, status: 'run-failed', error: (err as { message?: unknown } | null | undefined)?.message ?? String(err) };
    process.exitCode = 1;
    try {
      writeOut(outArg, qualityArtifact({ incomplete: true, error: `quality run failed: ${cacheState.error}` }));
    } catch (evidenceError) {
      primaryError = new AggregateError([err, evidenceError], 'quality run and failure artifact both failed');
    }
    throw primaryError;
  } finally {
    if (!settled) work.discard(primaryError);
  }
}

if (qualityWork) await runQuality(qualityWork);
