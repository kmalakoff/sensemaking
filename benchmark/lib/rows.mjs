// The single row vocabulary: every table, frontmatter key, and numbers-of-record cell derives
// from this list. `key` is a dotted path into a run.mjs or eval.mjs JSON row (`inproc.cold_build_ms`
// reaches the nested field). `kind` is 'wall' | 'inproc' | 'tokens' | 'quality' | 'total'.
// `band` gates a same-sitting comparison (compare.mjs); `cross` gates a cross-sitting one (scale,
// stress, store batteries). `record` marks a numbers-of-record row. `source` names where the band
// came from. Labels keep the strings benchmark/reports/2026-08-30-0.20.0-release-gate.md already
// uses, so the vocabulary does not shift under existing reports.
//
// Only cold_crawl_ms, inproc.cold_build_ms and bulk_change_ms/bulk_watch_ms have a measured
// same-code spread. PLAN.md 3.10 and a second same-machine cross-sitting A/B (2026-09-01/02,
// identical published artifact, two sittings) agree: cold crawl and in-process cold build both
// read +21%, bulk change's first query read +73%. Every other wall/inproc row uses the cold
// figure as a starting proxy (0.21 same-sitting, 0.25 cross-sitting) until a real sitting
// measures its own spread -- phase 1b's extra samples are for that measurement, not for
// tightening these numbers now. The cross-sitting band is wider than the same-sitting one
// (0.25 vs 0.21) on purpose: a tighter cross-sitting band read a +49% cold-build swing as a
// regression on this repo, and a clean re-run put the real number at +0.7% -- a release cycle
// of doubt a 0.10 band would reproduce on every sitting.
const MEASURED_COLD_BAND = 0.21;
const MEASURED_COLD_CROSS = 0.25;
const MEASURED_BULK = 0.73;
const PROXY = 0.25;
const PROXY_CROSS = 0.3;
const COLD_SOURCE = 'PLAN.md 3.10 and a 2026-09-01/02 cross-sitting A/B on this machine: cold crawl and in-process cold build both +21% on an identical published artifact across two sittings; cross band widened to 0.25 so that spread reads as noise, not a regression (see BENCHMARKING.md methodology changelog)';

export const ROWS = [
  // This row used to swing with file-cache state: -38% at 13k and -40% at 26k on one unchanged
  // tree a day apart, against -4.9% for the in-process build, which always ran later and so was
  // always warm. run.mjs now warms the cache before anything is timed, so every sitting measures
  // the same thing and the row gates again on the ordinary band.
  {
    key: 'cold_crawl_ms',
    label: 'cold crawl (wall)',
    kind: 'wall',
    band: MEASURED_COLD_BAND,
    cross: MEASURED_COLD_CROSS,
    record: true,
    source: `${COLD_SOURCE}. The file-cache swing that once disqualified this row cross-sitting (-38% and -40% on an unchanged tree a day apart) is measured away by run.mjs's warm-up pass, not banded around`,
  },
  { key: 'version_canary_ms', label: '`--version` canary', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'cold_embed_ms', label: 'embed cold build (crawl + first vector-participating `search`, one process)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: false, source: 'combines cold_crawl_ms with a first embed call; proxied off the cold-row starting band pending a real sitting' },
  { key: 'warm_query_ms', label: 'warm query (`COUNT(*)`)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  // Computed, not measured: the CLI's warm query minus the in-process open of the same work is what
  // an invocation pays before doing any (PLAN.md 3.11). kind 'total', so it reports and never gates.
  { key: 'setup_ms', label: 'invocation setup (warm query minus in-process open)', kind: 'total', band: PROXY, cross: PROXY_CROSS, record: false, source: 'derived from warm_query_ms and inproc.open_nochange_ms, both proxy-banded; no spread of its own has been measured, so it reports and does not gate' },
  { key: 'find_ms', label: 'lexical `search` (BM25 + link fusion)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'words_ms', label: 'words-only `search` (BM25, no link fusion)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: false, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'find_row_tokens', label: '`search` row size (json)', kind: 'tokens', record: true },
  { key: 'semantic_find_ms', label: 'semantic `search` (steady state)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'map_ms', label: '`map` (orient)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'map_tokens', label: '`map` token count', kind: 'tokens', record: true },
  { key: 'peek_ms', label: '`peek` largest note', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'peek_tokens', label: '`peek` token count', kind: 'tokens', record: true },
  { key: 'path_ms', label: '`path` (graph traversal)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: false, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'related_ms', label: '`related` (similar-but-unlinked)', kind: 'wall', band: PROXY, cross: PROXY_CROSS, record: false, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'related_tokens', label: '`related` token count', kind: 'tokens', record: false },
  // kind 'total': informational, never gates (see classify.mjs). A row that varies 73% on
  // identical code cannot detect anything smaller than 73%; as a gate it would only produce
  // false positives. Do not promote this back to 'wall' without a fresh spread measurement.
  { key: 'bulk_change_ms', label: 'bulk change: first query', kind: 'total', band: MEASURED_BULK, cross: MEASURED_BULK, record: false, source: 'PLAN.md 3.10 and a 2026-09-01/02 cross-sitting A/B: +73% on an identical artifact across sittings' },
  { key: 'bulk_watch_ms', label: 'bulk change: with warm watcher', kind: 'total', band: MEASURED_BULK, cross: MEASURED_BULK, record: false, source: 'PLAN.md 3.10: proxied off bulk_change_ms, the sibling scenario measured there' },
  { key: 'inproc.cold_build_ms', label: 'in-process: cold index build', kind: 'inproc', band: MEASURED_COLD_BAND, cross: MEASURED_COLD_CROSS, record: true, source: COLD_SOURCE },
  // Time no stage claims (src/store/stages.ts): informational, never gates. A residual that
  // grows across releases signals the stage vocabulary stopped covering the build.
  { key: 'inproc.unaccounted_ms', label: 'in-process: cold build residual (unaccounted for by any stage)', kind: 'total', band: PROXY, cross: PROXY_CROSS, record: false, source: 'derived from inproc.stages; no spread of its own has been measured, so it reports and does not gate' },
  { key: 'inproc.open_nochange_ms', label: 'in-process: freshness check, no change', kind: 'inproc', band: PROXY, cross: PROXY_CROSS, record: true, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'inproc.update_1_file_ms', label: 'in-process: update, 1 file touched', kind: 'inproc', band: PROXY, cross: PROXY_CROSS, record: false, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'inproc.update_10_files_ms', label: 'in-process: update, 10 files modified', kind: 'inproc', band: PROXY, cross: PROXY_CROSS, record: false, source: 'no dedicated spread measurement yet; proxied off the cold-row starting band pending a real sitting' },
  { key: 'ndcg', label: 'nDCG@10', kind: 'quality', record: true },
  { key: 'rr', label: 'MRR@10', kind: 'quality', record: false },
  { key: 'hit', label: 'hit@10', kind: 'quality', record: true },
];

export const ROW_BY_KEY = new Map(ROWS.map((row) => [row.key, row]));

// Walks a dotted key ('inproc.cold_build_ms') into a run.mjs/eval.mjs JSON row. Returns
// undefined for a missing segment rather than throwing, since a pre-embed package's row lacks
// keys a newer one carries.
export function rowValue(record, key) {
  return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), record);
}

// Every kind a run.mjs row carries a real measured value for: wall/inproc/tokens gate on their
// band, 'total' (bulk_change_ms, bulk_watch_ms, inproc.unaccounted_ms) is reported but never
// gates. One constant so compare.mjs, verdict.mjs and the harness test filter run.mjs's own fields the same way.
export const TIMING_KINDS = ['wall', 'inproc', 'tokens', 'total'];

// The metric keys a run.mjs row is expected to carry, flattened the same way rowValue() reads
// them -- 'inproc.cold_build_ms' both ways -- so a harness test can assert a real row's key set
// against this list with no separate flattening logic to drift.
export const RUN_METRIC_KEYS = ROWS.filter((row) => TIMING_KINDS.includes(row.kind)).map((row) => row.key);

// The companion sample-array keys phase 1b's median rows carry beside their median, one level
// up from the median key itself ('cold_crawl_ms' -> 'cold_crawl_ms_samples',
// 'inproc.cold_build_ms' -> 'inproc.cold_build_ms_samples').
export const SAMPLE_KEYS = ['cold_crawl_ms', 'bulk_change_ms', 'bulk_watch_ms', 'inproc.cold_build_ms'].map((key) => `${key}_samples`);

// Every top-level run.mjs field that is not a measured metric: identifying/context fields and
// the median rows' companion sample arrays.
export const RUN_META_KEYS = ['measure_version', 'tree', 'work_tree', 'copy_ms', 'store', 'notes', 'largest_note_tokens', 'embed_supported', 'cold_embed_error', 'errors', 'bulk_files', 'inproc', 'cold_crawl_ms_samples', 'bulk_change_ms_samples', 'bulk_watch_ms_samples', 'warmed_bytes'];

// Same, for the nested inproc object: its own sample array, the error string a broken build
// reports instead of every timing, and each rep's per-stage split. `stages` (and the update reps'
// namesakes) is diagnostic structure, not a gated metric: no stage has a measured spread yet.
export const INPROC_META_KEYS = ['cold_build_ms_samples', 'stages', 'update_1_file_stages', 'update_10_files_stages', 'error'];
