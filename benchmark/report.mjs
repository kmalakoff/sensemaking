// Renders benchmark/reports/<date>-release-gate.{json,md} from a sitting directory under
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
import { stringify } from 'yaml';
import { mdTable } from './lib/render.mjs';
import { ROWS } from './lib/rows.mjs';
import { DEFAULT_STORE, OFFERED, ROOT } from './lib/stages.mjs';
import { aggregateVerdict, classifyCompare, classifyCrossGroup, classifyEval, findPriorReport } from './lib/verdict.mjs';

export const REPORTS_DIR = join(ROOT, 'benchmark', 'reports');
export const SITTINGS_DIR = join(ROOT, '.tmp', 'sittings');
export const BENCHMARKING_MD = join(ROOT, 'BENCHMARKING.md');
export const NUMBERS_START = '<!-- numbers -->';
export const NUMBERS_END = '<!-- /numbers -->';

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
        .filter((f) => /^\d{4}-\d{2}-\d{2}-release-gate\.json$/.test(f))
        .sort()
    : [];
  if (files.length === 0) throw new Error(`no report under ${reportsDir} to accept a row against; run node benchmark/gate.mjs first`);
  return join(reportsDir, files[files.length - 1]);
}

// Every step JSON this sitting could have produced, classified into the compare-stage
// same-sitting table, the hub/13k/26k consistent-growth group (default store), a lone group per
// stress and per store battery, and one quality classification per eval corpus.
function classifySitting(sittingDir, sitting, priorReport) {
  const priorSteps = priorReport?.steps ?? {};
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
    const priorScaleGroup = { hub: priorSteps.compare?.results?.local, 'scale-13k': priorSteps['scale-13k'], 'scale-26k': priorSteps['scale-26k'] };
    classifications.push(...classifyCrossGroup(scaleGroup, priorScaleGroup));
  }

  const stressJson = loadStep('stress');
  if (stressJson) {
    steps.stress = stressJson;
    classifications.push(...classifyCrossGroup({ stress: stressJson }, { stress: priorSteps.stress }));
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
      const priorGroup = Object.fromEntries(Object.keys(group).map((id) => [id, priorSteps[id]]));
      classifications.push(...classifyCrossGroup(group, priorGroup));
    }
    const stressId = `battery-${store}-stress`;
    const sj = loadStep(stressId);
    if (sj) {
      steps[stressId] = sj;
      classifications.push(...classifyCrossGroup({ [stressId]: sj }, { [stressId]: priorSteps[stressId] }));
    }
  }

  const retrievalOwed = !!sitting.owed?.fever;
  for (const id of ['eval-nfcorpus', 'eval-fever']) {
    const j = loadStep(id);
    if (j) {
      steps[id] = j;
      classifications.push(...classifyEval(id, j, priorSteps[id], retrievalOwed));
    }
  }

  return { classifications, steps };
}

const CONTEXT_SLUG = (context) => context.replace(/[-/]/g, '_');

// The full fixed context list, independent of what any one sitting measures: the default
// store's hub/13k/26k/stress, every other offered store's own battery sizes, and the two eval
// corpora's semantic pass. Frontmatter carries a key for every (context, record:true row) pair
// from this list, null where a sitting did not measure it, never an absent key.
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
    for (const row of QUALITY_RECORD_ROWS) fields[`${CONTEXT_SLUG(context)}_${row.key}`] = byId.get(`${context}/semantic/${row.key}`)?.current ?? null;
  }
  return fields;
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

export function buildReport(sittingDir, { reportsDir = REPORTS_DIR, releaseVersionOverride } = {}) {
  const sitting = JSON.parse(readFileSync(join(sittingDir, 'sitting.json'), 'utf8'));
  const jsonPath = join(reportsDir, `${sitting.date}-release-gate.json`);
  const existing = readJson(jsonPath);
  const accepted = existing?.accepted ?? {};

  const priorReport = findPriorReport(reportsDir, sitting.date);
  const { classifications, steps } = classifySitting(sittingDir, sitting, priorReport);
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
    // eval.mjs's own --model default; eval.mjs's --out JSON does not record the model name it used.
    embed_model: Object.values(steps).some((s) => s?.variants?.semantic) ? 'minishlab/potion-retrieval-32M' : null,
    verdict,
    verdict_reasons: reasons,
    // Provenance is the last tag (tags do not move) plus the path list the gate read to decide
    // what was owed, never a commit hash: a rebase or squash can orphan a hash this report would
    // otherwise depend on (RELEASING.md's own rule, and what happened to the 0.20.0 report).
    last_tag: sitting.last_tag ?? null,
    changed_paths: sitting.changed_paths ?? [],
    owed: sitting.owed ?? {},
    steps_status: sitting.steps ?? {},
    changelog_entry: sitting.changelog_entry ?? null,
    classifications,
    accepted,
    record,
    steps,
    generated: true,
  };
}

// Writes the JSON, the frontmatter + generated body md, and -- only on PASS -- repoints
// BENCHMARKING.md's numbers of record. The one place both writeReport and acceptRow land a
// report, so a re-render and an acceptance always produce the same file shape.
export function persist(report, { reportsDir = REPORTS_DIR, benchmarkingMdPath = BENCHMARKING_MD } = {}) {
  mkdirSync(reportsDir, { recursive: true });
  const jsonPath = join(reportsDir, `${report.date}-release-gate.json`);
  const mdPath = join(reportsDir, `${report.date}-release-gate.md`);
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

// Regenerates the numbers-of-record table between the markers: every metric this report
// measured is added or repointed at it, and every metric it did not measure keeps its previous
// row untouched -- nothing is deleted. Never called when the sitting blocked: a blocked
// sitting's numbers must never become the official ones.
export function updateNumbersOfRecord(report, benchmarkingMdPath = BENCHMARKING_MD) {
  if (!existsSync(benchmarkingMdPath)) return;
  const md = readFileSync(benchmarkingMdPath, 'utf8');
  const start = md.indexOf(NUMBERS_START);
  const end = md.indexOf(NUMBERS_END);
  if (start < 0 || end < 0) return; // markers not present yet in this tree; nothing to update
  const rows = parseNumbersTable(md, start + NUMBERS_START.length, end);
  const link = `[${report.date} release gate](benchmark/reports/${report.date}-release-gate.md)`;
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
  const argv = process.argv.slice(2);
  const acceptIdx = argv.indexOf('--accept');
  if (acceptIdx >= 0) {
    const rowId = argv[acceptIdx + 1];
    const reasonIdx = argv.indexOf('--reason');
    const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] : null;
    if (!rowId || !reason) {
      console.error('usage: node benchmark/report.mjs --accept <row id> --reason "<owner words>"');
      process.exit(2);
    }
    const report = acceptRow(rowId, reason);
    console.log(`accepted ${rowId}: ${reason}`);
    console.log(`verdict now: ${report.verdict}`);
    return;
  }

  const sittingIdx = argv.indexOf('--sitting');
  const sittingDir = sittingIdx >= 0 ? resolve(argv[sittingIdx + 1]) : newestSittingDir();
  if (!existsSync(join(sittingDir, 'sitting.json'))) {
    console.error(`no sitting.json under ${sittingDir}`);
    process.exit(2);
  }
  const releaseIdx = argv.indexOf('--release');
  const releaseVersionOverride = releaseIdx >= 0 ? argv[releaseIdx + 1] : undefined;

  const report = buildReport(sittingDir, { releaseVersionOverride });
  persist(report);
  console.log(`wrote benchmark/reports/${report.date}-release-gate.md`);
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
