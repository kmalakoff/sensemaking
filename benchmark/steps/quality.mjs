// Retrieval quality in three passes (bm25-only, fused, semantic) plus a hidden guard pass: a vectors-free preset must be row-identical to `fused`. Paired deltas with a sign-test z.
// usage: node benchmark/steps/quality.mjs [corpus] [--queries N] [--k N] [--split test|dev] [--store name] [--query-form or-bag|bare-and] [--out file]
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { corpusLabels, corpusPath } from '../lib/corpus.mjs';
import { readLabels } from '../lib/labels.mjs';
import { MEASURE_VERSION } from '../lib/measure.mjs';
import { mean } from '../lib/metrics.mjs';
import { writeOut } from '../lib/out.mjs';
import { buildQualityArtifactBase, evaluateVariant, qualityVariantEvidence, queryFormFor } from '../lib/quality.mjs';
import { observeQualityModel, prepareQualityWorkTree } from '../lib/quality-work-tree.mjs';
import { mdTable } from '../lib/render.mjs';
import { ROWS } from '../lib/rows.mjs';
import { executionEvidence, identityHash, implementationProvenance, logicalWorkloadIdentity, manifestIdentity } from '../lib/workload-identity.mjs';

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
const flag = (name, dflt) => flags[name] ?? dflt;
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

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const source = corpusPath(corpus);
const labelsDir = corpusLabels(corpus);
if (!source || !labelsDir) {
  console.error(`not a labeled corpus: ${corpus}`);
  process.exit(2);
}
const lib = await import(pathToFileURL(join(ROOT, 'dist', 'esm', 'index.js')).href);

const { queries, qrels } = readLabels(labelsDir, SPLIT);
const qids = [...qrels.keys()].sort().slice(0, MAX_QUERIES === Infinity ? undefined : MAX_QUERIES);
let tree = null;
let cacheState = null;

const baseArtifact = () => ({ ...buildQualityArtifactBase({ corpus, split: SPLIT, qids, k: K, store: STORE ?? 'sqlite', source, tree, measureVersion: MEASURE_VERSION, queries, qrels, queryForm: QUERY_FORM, queryFor }), cache: cacheState });
if (qids.length === 0) {
  writeOut(outArg, { ...baseArtifact(), incomplete: true, error: 'zero qids: no labeled queries selected' });
  console.error('zero qids: no labeled queries selected');
  process.exit(1);
}

// embed false -> vectors-free signals map (vectors never built); embed true -> config names the model and vectors build lazily on the first participating call. Without an embed block, the semantic pass silently measures lexical.
// --model/--provider/--url let a non-default corpus (e.g. an HTTP encoder over Ollama) reuse this real search()-through-chunk() path instead of bakeoff's whole-document scoring.
const EMBED = { model: flag('model', 'minishlab/potion-retrieval-32M'), provider: flag('provider', 'static'), url: flag('url', undefined) };
const safeInvocationArgs = (args) => args.map((arg, index) => (arg === '--url' || args[index - 1] === '--url' ? (arg === '--url' ? arg : '<redacted>') : arg.startsWith('--url=') ? '--url=<redacted>' : arg));
// There is no per-call semantic option: the preset decides. `semanticOff` writes a vectors-free `signals` weight map into the preset.
// That's the one lever the no-silent-change contract is about.
const VARIANTS = [
  { name: 'bm25-only', features: { links: false, rank: false }, embed: false, semanticOff: true },
  { name: 'fused', features: undefined, embed: false, semanticOff: true },
  { name: 'fused-embed-configured', features: undefined, embed: true, semanticOff: true, hidden: true }, // guard only
  { name: 'semantic', features: undefined, embed: true, semanticOff: false },
];

const configFor = (variant, baseDir) => ({
  presets: { default: { include: ['**/*.md'], ...(variant.semanticOff ? { signals: variant.features?.links === false ? { words: 1 } : { words: 1, links: 1 } } : {}) } },
  ...(variant.embed ? { embed: EMBED } : {}),
  features: variant.features,
  queries: {},
  baseDir,
  configPath: null,
  ...(STORE ? { store: STORE } : {}),
});
const logicalConfig = ({ baseDir: _baseDir, configPath: _configPath, store: _store, ...config }) => config;
const modelObservation = await observeQualityModel(ROOT, EMBED);
const provenanceFor = (model) =>
  implementationProvenance({
    packageRoot: ROOT,
    harnessRoot: ROOT,
    harnessFiles: ['benchmark/steps/quality.mjs', 'benchmark/lib/quality.mjs', 'benchmark/lib/quality-work-tree.mjs', 'benchmark/lib/workload-identity.mjs'],
    store: STORE ?? 'sqlite',
    nativeObservation: { function: 'not queried by quality cache preflight', value: 'unobserved', status: null, error: null },
    modelObservation: model,
  });
const cacheInputsFor = (model) => {
  const provenance = provenanceFor(model);
  return {
    version: 1,
    configs: VARIANTS.map((variant) => ({ name: variant.name, config: executionEvidence({ argv: [], config: configFor(variant, '<private-tree>') }).config })),
    implementation: { measured_package: provenance.measured_package, runtime: provenance.runtime, native: provenance.native, harness: provenance.harness },
    model,
  };
};
const initialCacheInputs = cacheInputsFor(modelObservation);
let qualityWork;
try {
  qualityWork = prepareQualityWorkTree({ workRoot: join(ROOT, '.tmp', 'eval-work'), key: `${corpus}-${STORE ?? 'sqlite'}`, source, cacheInputs: initialCacheInputs, reuseEligible: modelObservation.reuse_eligible });
  tree = qualityWork.tree;
  cacheState = { cache_fingerprint: qualityWork.cacheFingerprint, cache_inputs: qualityWork.cacheInputs, copied_state: qualityWork.copied_state, reuse_state: qualityWork.reuse_state, reused_generation: qualityWork.reused_generation };
} catch (err) {
  cacheState = { status: 'preflight-failed', error: err?.message ?? String(err) };
  writeOut(outArg, { ...baseArtifact(), incomplete: true, error: `quality cache preflight failed: ${cacheState.error}` });
  console.error(`quality cache preflight failed: ${cacheState.error}`);
  process.exitCode = 1;
}

/** @param {ReturnType<typeof prepareQualityWorkTree>} work */
async function runQuality(work) {
  let settled = false;
  let primaryError = null;
  const results = [];
  const qualityArtifact = (extra = {}) => ({
    ...baseArtifact(),
    ...extra,
    variants: Object.fromEntries(results.map((r) => [r.name, qualityVariantEvidence(r)])),
  });
  try {
    for (const variant of VARIANTS) {
      const cfg = configFor(variant, tree);
      const errorDetails = [];
      let storeHandle = null;
      let measured = null;
      try {
        const opened = await lib.open(cfg);
        storeHandle = opened.store;
        measured = await evaluateVariant({ qids, queries, qrels, k: K, search: (terms, options) => lib.search(storeHandle, cfg, terms, options), queryFor });
        errorDetails.push(...measured.errorDetails);
      } catch (err) {
        errorDetails.push({ qid: null, error: `open: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
      } finally {
        if (storeHandle) {
          try {
            await storeHandle.close();
          } catch (err) {
            errorDetails.push({ qid: null, error: `close: ${err?.name ?? 'Error'}: ${err?.message ?? err}` });
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
        ...(measured ?? { perQuery: new Map(), incomplete: true, ms: null }),
        errors: errorDetails.length,
        error_details: errorDetails,
      });
      if (errorDetails.length > 0 || results.at(-1).incomplete) break;
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
    const fused = results.find((r) => r.name === 'fused');
    const fusedEmbedConfigured = results.find((r) => r.name === 'fused-embed-configured');
    const divergent = qids.filter((qid) => fused.perQuery.get(qid)?.rows !== fusedEmbedConfigured.perQuery.get(qid)?.rows);
    if (divergent.length > 0) {
      writeOut(outArg, qualityArtifact({ error: `NO-SILENT-CHANGE VIOLATION: ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})` }));
      console.error(`NO-SILENT-CHANGE VIOLATION: semantic:false didn't fully disable vectors on the embed-configured corpus -- ${divergent.length}/${qids.length} queries diverged from fused (first: ${divergent[0]})`);
      process.exitCode = 1;
      return;
    }
    console.log(`no-silent-change: ok — semantic:false on an embed-configured corpus is row-identical to fused (vectors never built) across ${qids.length} queries\n`);

    const aggregate = (result) => mean(qids.map((qid) => result.perQuery.get(qid).m));
    const shown = results.filter((r) => !r.hidden);
    const aggregates = new Map(shown.map((result) => [result.name, aggregate(result)]));
    const qualityRows = ROWS.filter((row) => row.kind === 'quality');
    console.log(`corpus: ${corpus} | split: ${SPLIT} | queries: ${qids.length} | k: ${K} | query form: ${QUERY_FORM}\n`);
    console.log(mdTable(['metric', ...shown.map((r) => r.name)], [...qualityRows.map((row) => [row.label, ...shown.map((r) => aggregates.get(r.name)[row.key].toFixed(4))]), ['mean ms/query', ...shown.map((r) => r.ms.toFixed(1))]]));

    // Paired per-query deltas between adjacent pairs of interest.
    function paired(a, b, key) {
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
    const bm25 = results.find((r) => r.name === 'bm25-only');
    const semantic = results.find((r) => r.name === 'semantic');
    console.log('\npaired per-query deltas (wins/losses, sign-test z; |z| > 2 is beyond noise):');
    const pairedOut = {};
    for (const [label, key, a, b] of [
      ['fused vs bm25-only', 'fused_vs_bm25', bm25, fused],
      ['semantic vs fused', 'semantic_vs_fused', fused, semantic],
    ]) {
      const nd = paired(a, b, 'ndcg');
      const h = paired(a, b, 'hit');
      console.log(`- ${label}: nDCG ${nd.wins}W/${nd.losses}L z=${nd.z.toFixed(1)} · hit ${h.wins}W/${h.losses}L z=${h.z.toFixed(1)}`);
      pairedOut[key] = { ndcg: nd, hit: h };
    }
    const errTotal = results.filter((r) => r.errors > 0);
    if (errTotal.length > 0) console.log(`\nerrors: ${errTotal.map((r) => `${r.name}=${r.errors}`).join(', ')}`);

    let cacheEvidence;
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
    cacheState = { ...cacheState, status: 'run-failed', error: err?.message ?? String(err) };
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
