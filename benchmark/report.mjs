// Renders benchmark/reports/<date>-<version>-release-gate.{json,md} from a sitting directory under
// .tmp/sittings/. Recomputes classification from the sitting's own step JSONs and the newest
// earlier release-gate JSON every time, so re-running this against the same sitting is
// idempotent: same inputs, same output, byte for byte. Never re-measures anything.
//
// usage: node benchmark/report.mjs [--sitting <dir>] [--release <version>]
//        node benchmark/report.mjs --accept <row id> --reason "<owner's words>"
//
// On PASS (or once every blocking row from the newest report carries an accepted override),
// BENCHMARKING.md's numbers-of-record table is repointed at this report; on BLOCK it is left
// exactly as it was, because a blocked sitting's numbers must never become the official ones.
//
// Every exported function takes its target paths through an options object, defaulted to the
// real repo locations -- test/integration/docs.test.ts points them at scratch instead, so
// exercising this module never writes into the tracked benchmark/reports/ or BENCHMARKING.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { MEASURE_VERSION } from './lib/measure.mjs';
import { mdTable } from './lib/render.mjs';
import { ROWS } from './lib/rows.mjs';
import { DEFAULT_STORE, OFFERED, ROOT } from './lib/stages.mjs';
import { aggregateVerdict, classifyCompare, classifyCrossGroup, classifyEval, findPriorReports, priorStepLookup } from './lib/verdict.mjs';

export const REPORTS_DIR = join(ROOT, 'benchmark', 'reports');
export const SITTINGS_DIR = join(ROOT, '.tmp', 'sittings');
export const BENCHMARKING_MD = join(ROOT, 'BENCHMARKING.md');
export const NUMBERS_START = '<!-- numbers -->';
export const NUMBERS_END = '<!-- /numbers -->';

// A report is named for the release it gates, falling back to the package version the sitting
// measured against until `--release` names it. Two sittings never share a name unless they gate the
// same release, which is the fix-and-rerun case where replacing the report is the point.
export function reportBase(date, version) {
  return version ? `${date}-${version}-release-gate` : `${date}-release-gate`;
}

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

function newestSittingDir(sittingsDir = SITTINGS_DIR) {
  const dirs = existsSync(sittingsDir)
    ? readdirSync(sittingsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  if (dirs.length === 0) throw new Error(`no sitting under ${sittingsDir}; run node benchmark/gate.mjs first`);
  return join(sittingsDir, dirs[dirs.length - 1]);
}

export function newestReportPath(reportsDir = REPORTS_DIR) {
  const files = existsSync(reportsDir)
    ? readdirSync(reportsDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}(-[\w.+-]+)?-release-gate\.json$/.test(f))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`no report under ${reportsDir} to accept a row against; run node benchmark/gate.mjs first`);
  return join(reportsDir, files[files.length - 1]);
}

// Every step JSON this sitting could have produced, grouped into the same-sitting compare table,
// the hub/13k/26k growth group, a lone group per stress and per battery, and one per eval corpus.
function classifySitting(sittingDir, sitting, priorLookup) {
  // priorFrom records which report supplied each step's prior, for the run summary.
  const priorFrom = {};
  const priorHarnessMismatch = {};
  const priorStep = (id) => {
    const hit = priorLookup(id);
    if (!hit) return null;
    if (hit.mismatch) {
      priorFrom[id] = `${hit.from} (harness ${hit.mismatch.prior}, current ${hit.mismatch.current}; not compared)`;
      priorHarnessMismatch[id] = hit.mismatch;
      return null;
    }
    priorFrom[id] = hit.from;
    return hit.step;
  };
  const loadStep = (id) => readJson(join(sittingDir, `${id}.json`));

  const compareJson = loadStep('compare');
  const reversedJson = loadStep('compare-reversed');
  const classifications = [];
  const steps = {};
  if (compareJson) {
    classifications.push(...classifyCompare(compareJson, reversedJson));
    steps.compare = compareJson;
  }

  const scaleGroup = {};
  if (compareJson) scaleGroup.hub = compareJson.results[compareJson.versions[1]];
  for (const id of ['scale-13k', 'scale-26k']) {
    const j = loadStep(id);
    if (j) {
      scaleGroup[id] = j;
      steps[id] = j;
    }
  }
  if (Object.keys(scaleGroup).length > 0) {
    const priorScaleGroup = { hub: priorStep('compare')?.results?.local, 'scale-13k': priorStep('scale-13k'), 'scale-26k': priorStep('scale-26k') };
    classifications.push(...classifyCrossGroup(scaleGroup, priorScaleGroup));
  }

  const stressJson = loadStep('stress');
  if (stressJson) {
    steps.stress = stressJson;
    classifications.push(...classifyCrossGroup({ stress: stressJson }, { stress: priorStep('stress') }));
  }

  for (const store of OFFERED.filter((s) => s !== DEFAULT_STORE)) {
    const group = {};
    for (const size of ['hub', '13k', '26k']) {
      const id = `battery-${store}-${size}`;
      const j = loadStep(id);
      if (j) {
        group[id] = j;
        steps[id] = j;
      }
    }
    if (Object.keys(group).length > 0) {
      const priorGroup = Object.fromEntries(Object.keys(group).map((id) => [id, priorStep(id)]));
      classifications.push(...classifyCrossGroup(group, priorGroup));
    }
    const stressId = `battery-${store}-stress`;
    const sj = loadStep(stressId);
    if (sj) {
      steps[stressId] = sj;
      classifications.push(...classifyCrossGroup({ [stressId]: sj }, { [stressId]: priorStep(stressId) }));
    }
  }

  const retrievalOwed = !!sitting.owed?.fever;
  for (const id of ['eval-nfcorpus', 'eval-fever']) {
    const j = loadStep(id);
    if (j) {
      steps[id] = j;
      classifications.push(...classifyEval(id, j, priorStep(id), retrievalOwed));
    }
  }

  return { classifications, steps, priorFrom, priorHarnessMismatch };
}

// notes and largest note size per measured context: properties of the corpus, not measurements of
// sensemaking, so they sit in the report header rather than gating as timing rows.
function corpusShape(steps) {
  const shape = {};
  for (const [id, step] of Object.entries(steps)) {
    // compare.json wraps one run row per version; every other step's JSON is the row itself.
    const row = step?.results ? step.results[step.versions?.[1]] : step;
    if (typeof row?.notes !== 'number') continue;
    shape[id === 'compare' ? 'hub' : id] = { notes: row.notes, largest_note_tokens: row.largest_note_tokens ?? null };
  }
  return shape;
}

const CONTEXT_SLUG = (context) => context.replace(/[-/]/g, '_');

// The fixed context list, independent of what any one sitting measures. Frontmatter carries a key
// per (context, record row) pair from it, null where unmeasured, never an absent key.
const DEFAULT_CONTEXTS = ['hub', 'scale-13k', 'scale-26k', 'stress'];
const BATTERY_CONTEXTS = OFFERED.filter((s) => s !== DEFAULT_STORE).flatMap((store) => ['hub', '13k', '26k', 'stress'].map((size) => `battery-${store}-${size}`));
const EVAL_CONTEXTS = ['eval-nfcorpus', 'eval-fever'];
const TIMING_RECORD_ROWS = ROWS.filter((r) => r.record && (r.kind === 'wall' || r.kind === 'inproc' || r.kind === 'tokens'));
const QUALITY_RECORD_ROWS = ROWS.filter((r) => r.record && r.kind === 'quality');

export function recordFields(classifications) {
  const byId = new Map(classifications.map((c) => [c.id, c]));
  const fields = {};
  for (const context of [...DEFAULT_CONTEXTS, ...BATTERY_CONTEXTS]) {
    for (const row of TIMING_RECORD_ROWS) fields[`${CONTEXT_SLUG(context)}_${row.key.replace(/\./g, '_')}`] = byId.get(`${context}/${row.key}`)?.current ?? null;
  }
  for (const context of EVAL_CONTEXTS) {
    // 4 decimals is the precision these metrics are read and compared at; a raw float prints 16
    // digits of noise nobody uses.
    for (const row of QUALITY_RECORD_ROWS) {
      const v = byId.get(`${context}/semantic/${row.key}`)?.current;
      fields[`${CONTEXT_SLUG(context)}_${row.key}`] = typeof v === 'number' ? Number(v.toFixed(4)) : (v ?? null);
    }
  }
  return fields;
}

// The report this sitting already produced, if any: same date and same baseline. Named by release
// version once known, so the name alone cannot find it.
function existingReportFor(reportsDir, sitting) {
  if (!existsSync(reportsDir)) return null;
  for (const name of readdirSync(reportsDir)) {
    if (!name.endsWith('-release-gate.json') || !name.startsWith(sitting.date)) continue;
    const r = readJson(join(reportsDir, name));
    if (r?.package_version === sitting.baseline_version) return r;
  }
  return null;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`### ${report.date}: release gate`);
  lines.push('');
  lines.push(`\`node benchmark/gate.mjs\`, ${report.machine ?? 'unknown machine'}, Node ${report.node ?? 'unknown'}. Baseline: ${report.package_version ?? 'unknown'}. Last tag: ${report.last_tag ?? 'unknown'}.`);
  lines.push('');
  lines.push(`#### Verdict: ${report.verdict}`);
  lines.push('');
  if (report.verdict_reasons.length === 0) {
    lines.push('No BLOCK reason.');
  } else {
    for (const reason of report.verdict_reasons) lines.push(`- ${reason}`);
  }
  lines.push('');
  lines.push('A moved row localizes a cost; it does not identify its mechanism. Settling the mechanism means removing the suspected cause and re-measuring, or timing it directly -- never reading it off the delta.');
  lines.push('');
  const noise = report.classifications.filter((c) => c.verdict === 'noise' || c.verdict === 'flat');
  if (noise.length > 0) {
    lines.push('#### Moved inside band, judged noise');
    lines.push('');
    for (const c of noise.filter((c) => c.verdict === 'noise')) lines.push(`- ${c.reason}`);
    lines.push('');
  }
  if (Object.keys(report.accepted).length > 0) {
    lines.push('#### Owner decisions');
    lines.push('');
    for (const [id, { reason, date }] of Object.entries(report.accepted)) lines.push(`- ${id}: owner decision, ${date}: ${reason}`);
    lines.push('');
  }
  if (report.changelog_entry) {
    lines.push('#### What this sitting gates');
    lines.push('');
    lines.push(report.changelog_entry);
    lines.push('');
  }
  lines.push('#### Run summary');
  lines.push('');
  lines.push(`- provenance: last tag \`${report.last_tag ?? 'unknown'}\`, package version ${report.package_version ?? 'unknown'}, ${report.changed_paths?.length ?? 0} changed path(s) read to decide what was owed (no commit hash: RELEASING.md's rule, since a rebase or squash can orphan one)`);
  lines.push(`- owed: ${Object.keys(report.owed ?? {}).length > 0 ? Object.keys(report.owed).join(', ') : 'nothing beyond the always-owed stages'}`);
  lines.push(
    `- ran: ${Object.values(report.steps_status ?? {}).filter((s) => s.status === 'ok').length} step(s) ok, ${Object.values(report.steps_status ?? {}).filter((s) => s.status === 'not-owed').length} not owed, ${Object.values(report.steps_status ?? {}).filter((s) => s.status === 'owed-unmet').length} owed-unmet`
  );
  // A row with no prior was not compared, and an uncompared row cannot block. Counting them here
  // keeps a run that compared nothing from reading like a clean pass.
  const noPrior = report.classifications.filter((c) => c.verdict === 'no-prior').length;
  const compared = report.classifications.length - noPrior;
  lines.push(`- compared: ${compared} row(s) against a prior, ${noPrior} with no prior recorded (a row with no prior is not a pass, it is an absent comparison)`);
  const priorFrom = Object.entries(report.prior_from ?? {});
  if (priorFrom.length > 0) lines.push(`- priors read from: ${[...new Set(priorFrom.map(([, from]) => from))].sort().join(', ')}`);
  const mismatchIds = Object.keys(report.prior_harness_mismatch ?? {});
  if (mismatchIds.length > 0) lines.push(`- ${mismatchIds.length} step(s) had a prior measured by a different harness version and were not compared: ${mismatchIds.join(', ')}`);
  lines.push('');

  const grouped = new Map();
  for (const c of report.classifications) {
    if (!grouped.has(c.context)) grouped.set(c.context, []);
    grouped.get(c.context).push(c);
  }
  for (const [context, rows] of grouped) {
    lines.push(`#### ${context}`);
    lines.push('');
    lines.push(
      mdTable(
        ['row', 'prior', 'current', 'verdict', 'reason'],
        rows.map((c) => [c.key, String(c.prior ?? '—'), String(c.current ?? '—'), c.verdict, c.reason ?? '—'])
      )
    );
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// The CHANGELOG section for the version this sitting gates. Read here, not in the gate: the gate
// runs before the entry is written, so only the --release re-render can see it.
export function changelogEntry(version, changelogPath = join(ROOT, 'CHANGELOG.md')) {
  if (!version || !existsSync(changelogPath)) return null;
  const md = readFileSync(changelogPath, 'utf8');
  const start = md.search(new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm'));
  if (start < 0) return null;
  const rest = md.slice(start);
  const next = rest.slice(1).search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
}

export function buildReport(sittingDir, { reportsDir = REPORTS_DIR, releaseVersionOverride } = {}) {
  const sitting = JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8'));
  // A sitting's own report, found by what identifies it rather than by its name: the name carries
  // the release version, which this sitting does not know until --release supplies it.
  const existing = existingReportFor(reportsDir, sitting);
  const accepted = existing?.accepted ?? {};

  const priorReports = findPriorReports(reportsDir, sitting.date);
  const { classifications, steps, priorFrom, priorHarnessMismatch } = classifySitting(sittingDir, sitting, priorStepLookup(priorReports, MEASURE_VERSION));
  const { verdict, reasons } = aggregateVerdict(classifications, sitting.failed_stage_reasons ?? [], accepted);

  const record = recordFields(classifications);

  return {
    date: sitting.date,
    title: `${sitting.date} release gate`,
    package_version: sitting.baseline_version ?? null,
    release_version: releaseVersionOverride ?? existing?.release_version ?? null,
    chunk_version: sitting.chunk_version ?? null,
    schema_version: sitting.schema_version ?? null,
    machine: sitting.machine?.cpu_model ?? null,
    node: sitting.node ?? null,
    corpora: [
      ...new Set(
        Object.values(steps)
          .map((s) => s?.corpus ?? s?.tree)
          .filter(Boolean)
      ),
    ],
    corpus_shape: corpusShape(steps),
    // eval.mjs's own --model default; eval.mjs's --out JSON does not record the model name it used.
    embed_model: Object.values(steps).some((s) => s?.variants?.semantic) ? 'minishlab/potion-retrieval-32M' : null,
    verdict,
    verdict_reasons: reasons,
    // Provenance is the last tag plus the paths the gate read, never a commit hash: a rebase or
    // squash orphans a hash, and it orphaned the one the 0.20.0 report cited.
    last_tag: sitting.last_tag ?? null,
    // Which earlier report supplied the prior for each step. A step absent here had no prior in
    // any earlier report, so its rows are a real no-prior rather than a lookup that missed.
    prior_from: priorFrom,
    // Steps whose only earlier report was measured by a different harness version: not compared,
    // so their rows read no-prior rather than a (possibly false) delta across harnesses.
    prior_harness_mismatch: priorHarnessMismatch,
    changed_paths: sitting.changed_paths ?? [],
    owed: sitting.owed ?? {},
    steps_status: sitting.steps ?? {},
    changelog_entry: changelogEntry(releaseVersionOverride ?? existing?.release_version ?? null),
    classifications,
    accepted,
    record,
    steps,
    generated: true,
  };
}

// Writes the JSON and md, and on PASS alone repoints the numbers of record. The single landing
// point for both a re-render and an acceptance, so they cannot produce different shapes.
export function persist(report, { reportsDir = REPORTS_DIR, benchmarkingMdPath = BENCHMARKING_MD } = {}) {
  mkdirSync(reportsDir, { recursive: true });
  const base = reportBase(report.date, report.release_version ?? report.package_version);
  const jsonPath = join(reportsDir, `${base}.json`);
  const mdPath = join(reportsDir, `${base}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const frontmatter = {
    date: report.date,
    title: report.title,
    package_version: report.package_version,
    release_version: report.release_version,
    chunk_version: report.chunk_version,
    schema_version: report.schema_version,
    machine: report.machine,
    node: report.node,
    corpora: report.corpora,
    corpus_shape: report.corpus_shape,
    embed_model: report.embed_model,
    verdict: report.verdict,
    ...report.record,
  };
  writeFileSync(mdPath, `---\n${stringify(frontmatter)}---\n\n${renderMarkdown(report)}`);
  if (report.verdict === 'PASS') updateNumbersOfRecord(report, benchmarkingMdPath);
  return { jsonPath, mdPath };
}

// Every `| metric | value | report |` row currently between the markers, keyed by its metric
// cell, so a regeneration can keep a metric this sitting never measured rather than deleting it.
export function parseNumbersTable(md, start, end) {
  const rows = new Map();
  for (const line of md.slice(start, end).split('\n')) {
    const m = /^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/.exec(line.trim());
    if (!m || m[1] === 'metric' || /^-+$/.test(m[1])) continue;
    rows.set(m[1], [m[2], m[3]]);
  }
  return rows;
}

// Regenerates the numbers-of-record table: a measured metric is added or repointed, an unmeasured
// one keeps its row, nothing is deleted. Never called for a BLOCK, whose numbers are not official.
export function updateNumbersOfRecord(report, benchmarkingMdPath = BENCHMARKING_MD) {
  if (!existsSync(benchmarkingMdPath)) return;
  const md = readFileSync(benchmarkingMdPath, 'utf8');
  const start = md.indexOf(NUMBERS_START);
  const end = md.indexOf(NUMBERS_END);
  if (start < 0 || end < 0) return; // markers not present yet in this tree; nothing to update
  const rows = parseNumbersTable(md, start + NUMBERS_START.length, end);
  const link = `[${report.date} release gate](benchmark/reports/${reportBase(report.date, report.release_version ?? report.package_version)}.md)`;
  for (const [key, value] of Object.entries(report.record)) {
    if (value === null || value === undefined) continue;
    rows.set(key, [String(value), link]);
  }
  const table = mdTable(
    ['metric', 'value', 'report'],
    [...rows.entries()].map(([metric, [value, reportLink]]) => [metric, value, reportLink])
  );
  writeFileSync(benchmarkingMdPath, `${md.slice(0, start)}${NUMBERS_START}\n\n${table}\n\n${md.slice(end)}`);
}

export function acceptRow(rowId, reason, { reportsDir = REPORTS_DIR, benchmarkingMdPath = BENCHMARKING_MD } = {}) {
  // This is the only path that turns a BLOCK into a PASS, so a blank reason is refused here
  // rather than only at the CLI: an override with nothing written in it records no decision.
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(`accepting "${rowId}" needs a reason in the owner's own words; an override with no reason records no decision`);
  }
  const jsonPath = newestReportPath(reportsDir);
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const match = report.classifications.find((c) => c.id === rowId);
  if (!match) {
    throw new Error(`"${rowId}" is not a row in ${jsonPath}. Known row ids:\n${report.classifications.map((c) => `  ${c.id}`).join('\n')}`);
  }
  report.accepted[rowId] = { reason, date: new Date().toISOString().slice(0, 10) };
  // A stage failure never has a row id and so can never be overridden by --accept; carry the
  // original report's own stage-only reasons forward (its non-row reasons).
  const stageReasons = report.verdict_reasons.filter((r) => !report.classifications.some((c) => c.reason === r));
  const { verdict, reasons } = aggregateVerdict(report.classifications, stageReasons, report.accepted);
  report.verdict = verdict;
  report.verdict_reasons = reasons;
  persist(report, { reportsDir, benchmarkingMdPath });
  return report;
}

async function main() {
  const {
    values: { accept: rowId, reason, sitting: sittingArg, release: releaseVersionOverride },
  } = parseArgs({
    options: { accept: { type: 'string' }, reason: { type: 'string' }, sitting: { type: 'string' }, release: { type: 'string' } },
  });
  if (rowId !== undefined) {
    if (!rowId || !reason) {
      console.error('usage: node benchmark/report.mjs --accept <row id> --reason "<owner words>"');
      process.exit(2);
    }
    const report = acceptRow(rowId, reason);
    console.log(`accepted ${rowId}: ${reason}`);
    console.log(`verdict now: ${report.verdict}`);
    return;
  }

  const sittingDir = sittingArg ? resolve(sittingArg) : newestSittingDir();
  if (!existsSync(join(sittingDir, 'sitting.json'))) {
    console.error(`no sitting.json under ${sittingDir}`);
    process.exit(2);
  }
  const report = buildReport(sittingDir, { releaseVersionOverride });
  persist(report);
  console.log(`wrote benchmark/reports/${reportBase(report.date, report.release_version ?? report.package_version)}.md`);
  console.log(`verdict: ${report.verdict}`);
  console.log(report.verdict === 'PASS' ? 'numbers of record: updated' : 'numbers of record: left as they were (BLOCK)');
}

// Only run the CLI when this file is the entry point; report.mjs's functions are also imported
// directly by test/integration/docs.test.ts, which must not trigger a real render as a side effect.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
