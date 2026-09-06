import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import cr from 'cr';
import { STORE_NAMES, SUPPORTED_CONFIG_VERSION } from 'sensemaking';
import { parse } from 'yaml';
import { MEASURE_VERSION } from '../../benchmark/lib/measure.mjs';
import { REPORT_JSON_RE } from '../../benchmark/lib/verdict.mjs';
import { failedStageReasons } from '../../benchmark/report.mjs';
import { KNOWN_EMBED_KEYS } from '../../src/config/index.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

// Published surfaces drift silently: nothing fails when the README stops describing what
// ships. These are the two facts cheap enough to assert -- the rest is RELEASING.md step 5.

// Windows checks out CRLF; normalize so `\n` means the same thing on every platform.
// `cr` also folds a bare \r, which a hand-rolled /\r\n/ replace misses.
const read = (...parts: string[]) => cr(readFileSync(join(...parts), 'utf8'));

const readme = () => read(packageRoot, 'README.md');

describe('published docs', () => {
  it('README lists every command in the registry', async () => {
    const { COMMANDS } = (await import(pathToFileURL(join(packageRoot, 'dist', 'esm', 'cli', 'index.js')).href)) as { COMMANDS: Record<string, unknown> };
    const text = readme();
    for (const name of Object.keys(COMMANDS)) {
      assert.ok(new RegExp(`\`${name}[\\s"<\`]`).test(text), `${name} is a command but the README never shows it`);
    }
  });

  it('README config example is on the supported config version', () => {
    const example = JSON.parse(/```json\n([\s\S]*?)```/.exec(readme())?.[1] ?? '{}') as { version?: number };
    assert.equal(example.version, SUPPORTED_CONFIG_VERSION);
  });
});

describe('shipped skills are well formed', () => {
  // Not prose drift: these assert the artifacts this package ships are loadable at all. An
  // unquoted `description:` containing ": " parses as a nested mapping and the installer skips
  // the skill silently, so nothing else in the tree would notice.
  it('every SKILL.md has frontmatter that parses, with a name matching its directory and a description', () => {
    const dir = join(packageRoot, 'skills');
    assert.ok(existsSync(dir), 'skills/ must exist; package.json ships it');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    assert.ok(names.length > 0, 'skills/ must contain at least one skill');
    for (const name of names) {
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(read(dir, name, 'SKILL.md'));
      assert.ok(fm, `${name}/SKILL.md has no frontmatter block`);
      const parsed = parse(fm[1]) as { name?: string; description?: string };
      assert.equal(parsed.name, name, `${name}/SKILL.md declares a name that is not its directory`);
      assert.ok(parsed.description && parsed.description.length > 0, `${name}/SKILL.md has no description`);
    }
  });

  it('package.json ships the skills directory, so a publish cannot drop it', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { files: string[] };
    assert.ok(pkg.files.includes('skills'), 'skills/ is not in package.json files');
  });
});

describe('schema.json matches the code that decides what is valid', () => {
  // schema.json ships in files and every generated config points $schema at it, so drift here
  // makes an editor flag a valid key as invalid.
  const schema = () => JSON.parse(readFileSync(join(packageRoot, 'schema.json'), 'utf8'));

  it('the store enum equals STORE_NAMES', () => {
    assert.deepEqual(schema().properties.store.enum, [...STORE_NAMES]);
  });

  it('every KNOWN_EMBED_KEYS key is a property under properties.embed.properties', () => {
    const embedProps = Object.keys(schema().properties.embed.properties);
    for (const key of KNOWN_EMBED_KEYS) assert.ok(embedProps.includes(key), `schema.json's embed properties is missing "${key}"`);
  });
});

// The release-gate benchmark harness (benchmark/report.mjs and friends): generated numbers of
// record, the owner-override contract, and idempotent re-rendering. See benchmark-automation.md.

// Fabricated, not measured: a benchmark fixture built as data, per the plan's own rule that a
// timing check is never exercised by running the real gate here.
// steps is what an earlier run recorded, carried across a resume untouched; its reasons come from
// the harness's own function, so the fixture cannot drift from the key format gate.mjs writes.
function fixtureSitting(dir: string, date: string, findRowTokens: [number, number], steps: Record<string, { id: string; status: string }> = {}): void {
  writeFileSync(
    join(dir, 'sitting.json'),
    JSON.stringify({
      date,
      baseline_version: '9.9.9',
      last_tag: 'v9.9.8',
      machine: { cpu_model: 'Fixture CPU', cpu_count: 8, arch: 'arm64' },
      node: 'v99.0.0',
      chunk_version: 'chunk:v99',
      schema_version: { sqlite: '99', duckdb: '9', turso: '9' },
      changed_paths: ['src/chunk/index.ts'],
      owed: { baseline: ['src/chunk/index.ts'] },
      continue: false,
      steps,
      failed_stage_reasons: failedStageReasons(steps),
    })
  );
  const row = (tokens: number) => ({
    cold_crawl_ms: 100,
    version_canary_ms: 20,
    warm_query_ms: 50,
    find_ms: 60,
    find_row_tokens: tokens,
    cold_embed_ms: 200,
    semantic_find_ms: 90,
    map_ms: 40,
    map_tokens: 496,
    peek_ms: 35,
    peek_tokens: 581,
    related_ms: 80,
    related_tokens: 60,
    largest_note_tokens: 77274,
    bulk_change_ms: 600,
    bulk_watch_ms: 150,
    inproc: { cold_build_ms: 2100, open_nochange_ms: 35, update_1_file_ms: 38, update_10_files_ms: 44 },
  });
  writeFileSync(
    join(dir, 'compare.json'),
    JSON.stringify({
      corpus: '/fixture/tree',
      store: 'sqlite',
      versions: ['9.9.8', 'local'],
      reversed: false,
      results: { '9.9.8': row(findRowTokens[0]), local: row(findRowTokens[1]) },
    })
  );
}

describe('benchmark release-gate: numbers of record', () => {
  it('the tracked numbers-of-record table equals a fresh render of the newest release-gate JSON, where one exists', async () => {
    const reportsDir = join(packageRoot, 'benchmark', 'reports');
    const jsonFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => REPORT_JSON_RE.test(f)) : [];
    if (jsonFiles.length === 0) return; // no generated report has landed yet (phase 4 migration, out of scope here)
    const newest = jsonFiles.sort().at(-1) as string;
    const { updateNumbersOfRecord, parseNumbersTable, NUMBERS_START: START, NUMBERS_END: END } = await import('../../benchmark/report.mjs');
    const report = JSON.parse(readFileSync(join(reportsDir, newest), 'utf8'));
    if (report.verdict !== 'PASS') return; // a blocked sitting's numbers are never the official ones
    const scratch = scratchDir('numbers-render');
    const mdPath = join(scratch, 'BENCHMARKING.md');
    const tracked = readFileSync(join(packageRoot, 'BENCHMARKING.md'), 'utf8');
    const start = tracked.indexOf(START);
    const end = tracked.indexOf(END);
    writeFileSync(mdPath, `${tracked.slice(0, start + START.length)}\n\n<!-- placeholder -->\n\n${tracked.slice(end)}`);
    updateNumbersOfRecord(report, mdPath);
    const rendered = parseNumbersTable(readFileSync(mdPath, 'utf8'), 0, readFileSync(mdPath, 'utf8').length);
    const live = parseNumbersTable(tracked, start, end);
    for (const [key, value] of Object.entries(report.record as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      assert.deepEqual(rendered.get(key)?.[0], live.get(key)?.[0], `BENCHMARKING.md's numbers-of-record row "${key}" does not match ${newest}`);
    }
  });

  it('fixture: a PASS sitting merges into the numbers-of-record table without deleting a metric it did not measure', async () => {
    const { buildReport, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('numbers-fixture-sitting');
    fixtureSitting(sitting, '2099-06-01', [71, 71]); // identical, so this sitting is PASS
    const reportsDir = scratchDir('numbers-fixture-reports');
    const mdPath = join(scratchDir('numbers-fixture-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n| metric | value | report |\n|---|---|---|\n| pre_existing_metric | 42 ms | [old](old.md) |\n\n${'<!-- /numbers -->'}\n`);
    const report = buildReport(sitting, { reportsDir, releaseVersionOverride: '9.9.10' }); // released: only a record repoints the numbers
    assert.equal(report.verdict, 'PASS');
    persist(report, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    const after = readFileSync(mdPath, 'utf8');
    assert.match(after, /pre_existing_metric \| 42 ms/, 'a metric this sitting never measured must survive a PASS regeneration');
    assert.match(after, /hub_find_row_tokens \| 71/, 'a metric this sitting measured must be added');
  });
});

describe('benchmark release-gate: the numbers of record never move to an older version', () => {
  it('fixture: a row pointing at a newer version is not overwritten by an older release, but is by a same-or-newer one', async () => {
    const { buildReport, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('numbers-version-order-sitting');
    fixtureSitting(sitting, '2099-06-07', [71, 71]); // identical, so this sitting is PASS
    const reportsDir = scratchDir('numbers-version-order-reports');
    const mdPath = join(scratchDir('numbers-version-order-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n| metric | value | report |\n|---|---|---|\n| hub_find_row_tokens | 999 | [2099-01-01 release gate](benchmark/reports/2099-01-01-9.9.12-release-gate.md) |\n\n${'<!-- /numbers -->'}\n`);

    const older = buildReport(sitting, { reportsDir, releaseVersionOverride: '9.9.10' });
    persist(older, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    let after = readFileSync(mdPath, 'utf8');
    assert.match(after, /hub_find_row_tokens \| 999/, 'a 9.9.10 release must not overwrite a row already pointing at 9.9.12');
    assert.match(after, /hub_map_tokens/, 'a metric this sitting measured that the table did not have yet must still be added');

    const newer = buildReport(sitting, { reportsDir, releaseVersionOverride: '9.9.12' });
    persist(newer, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    after = readFileSync(mdPath, 'utf8');
    assert.match(after, /hub_find_row_tokens \| 71/, 'a release at the same version as the row must overwrite it');
  });
});

describe('benchmark release-gate: owner override needs a reason', () => {
  it('acceptRow refuses a blank reason, whatever calls it', async () => {
    const { acceptRow, buildReport, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('accept-blank-sitting');
    fixtureSitting(sitting, '2099-06-03', [71, 90]); // token contract -> forced BLOCK
    const reportsDir = scratchDir('accept-blank-reports');
    const mdPath = join(scratchDir('accept-blank-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n<!-- /numbers -->\n`);
    persist(buildReport(sitting, { reportsDir }), { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });

    // The CLI already refuses a missing --reason. These reach acceptRow anyway, which is the only
    // path that can turn a BLOCK into a PASS.
    for (const blank of ['', '   ', '\n']) {
      assert.throws(() => acceptRow('compare/find_row_tokens', blank, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath }), /needs a reason/, `a reason of ${JSON.stringify(blank)} must be refused`);
    }
    const { SITTING_REPORT } = await import('../../benchmark/report.mjs');
    const stillBlocked = JSON.parse(readFileSync(join(sitting, `${SITTING_REPORT}.json`), 'utf8')) as { verdict: string; accepted: Record<string, unknown> };
    assert.equal(stillBlocked.verdict, 'BLOCK', 'a refused override must leave the verdict alone');
    assert.deepEqual(stillBlocked.accepted, {}, 'a refused override must record nothing');
  });

  it('fixture: report.mjs --accept refuses a missing reason at the CLI, and a recorded override always carries one', async () => {
    const { acceptRow, buildReport, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('accept-fixture-sitting');
    fixtureSitting(sitting, '2099-06-02', [71, 90]); // token contract -> forced BLOCK
    const reportsDir = scratchDir('accept-fixture-reports');
    const mdPath = join(scratchDir('accept-fixture-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n<!-- /numbers -->\n`);
    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK');
    persist(report, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    const accepted = acceptRow('compare/find_row_tokens', 'fixture: exercising the override', { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    assert.equal(accepted.verdict, 'PASS');
    assert.equal(accepted.accepted['compare/find_row_tokens'].reason, 'fixture: exercising the override');
    // Every accepted entry the module ever writes carries a non-empty reason: acceptRow has no
    // path that stores one without it (the CLI itself refuses before calling acceptRow).
    for (const entry of Object.values(accepted.accepted) as Array<{ reason: string }>) assert.ok(entry.reason.length > 0);
  });

  it('every release-gate JSON currently in the tree has a non-empty reason on every accepted row', () => {
    const reportsDir = join(packageRoot, 'benchmark', 'reports');
    const jsonFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => /-release-gate\.json$/.test(f)) : [];
    for (const file of jsonFiles) {
      const report = JSON.parse(readFileSync(join(reportsDir, file), 'utf8')) as { accepted?: Record<string, { reason?: string }> };
      for (const [id, entry] of Object.entries(report.accepted ?? {})) {
        assert.ok(entry.reason && entry.reason.trim().length > 0, `${file}: accepted row "${id}" has no reason`);
      }
    }
  });

  it('every BLOCK reason in a tracked release-gate JSON is either fixed by a later sitting or carries an owner decision', () => {
    const reportsDir = join(packageRoot, 'benchmark', 'reports');
    // Tracked only: an uncommitted report the gate just wrote would fail this spec inside the
    // gate's own stage-1 `npm test`, deadlocking the fix-and-rerun path RELEASING.md step 3 names.
    const tracked = new Set(
      execFileSync('git', ['ls-files', '--', 'benchmark/reports'], { cwd: packageRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map((p) => p.slice('benchmark/reports/'.length))
    );
    const jsonFiles = existsSync(reportsDir)
      ? readdirSync(reportsDir)
          .filter((f) => REPORT_JSON_RE.test(f) && tracked.has(f))
          .sort()
      : [];
    for (let i = 0; i < jsonFiles.length; i++) {
      const report = JSON.parse(readFileSync(join(reportsDir, jsonFiles[i]), 'utf8')) as { verdict: string; classifications: Array<{ id: string; verdict: string }>; accepted: Record<string, { reason?: string }> };
      if (report.verdict !== 'BLOCK') continue;
      const hasLaterSitting = i < jsonFiles.length - 1;
      if (hasLaterSitting) continue; // a later sitting is the fix; nothing to check on this one
      const blocking = report.classifications.filter((c) => ['moved', 'contract', 'fell'].includes(c.verdict));
      const unresolved = blocking.filter((c) => !report.accepted[c.id]?.reason);
      assert.deepEqual(
        unresolved.map((c) => c.id),
        [],
        `${jsonFiles[i]} is BLOCK, has no later sitting, and these rows have neither a fix nor an owner decision: ${unresolved.map((c) => c.id).join(', ')}`
      );
    }
  });
});

describe('benchmark release-gate: a stage failure has an owner path', () => {
  // The 0.23.0 shape: the A/B write-path step failed, the owner judged the diff and resumed. The
  // resume must not turn that into a pass; the owner's words on the stage reason must.
  const failedStoreDump = { 'store-dump': { id: 'store-dump', status: 'failed' } };
  const words = 'the A/B diff is the parser change the changelog names';

  it("fixture: accepting a stage reason with the owner's words clears the block and renders in the json and the md", async () => {
    const { acceptRow, buildReport, persist, SITTING_REPORT } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('accept-stage-sitting');
    fixtureSitting(sitting, '2099-06-04', [71, 71], failedStoreDump); // every row flat: the stage failure is the only block
    const reportsDir = scratchDir('accept-stage-reports');
    const mdPath = join(scratchDir('accept-stage-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n<!-- /numbers -->\n`);
    const blocked = buildReport(sitting, { reportsDir, releaseVersionOverride: '9.9.10' });
    assert.equal(blocked.verdict, 'BLOCK', 'a stage failure blocks on its own, with every row flat');
    assert.deepEqual(blocked.verdict_reasons, ['store-dump: failed']);
    persist(blocked, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });

    const accepted = acceptRow('store-dump: failed', words, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    assert.equal(accepted.verdict, 'PASS');
    assert.deepEqual(accepted.verdict_reasons, []);
    assert.equal(accepted.accepted['store-dump: failed'].reason, words);
    assert.match(accepted.accepted['store-dump: failed'].date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(accepted.stage_reasons, ['store-dump: failed'], 'the stage stays in the report, accepted rather than gone');
    assert.match(readFileSync(join(sitting, `${SITTING_REPORT}.md`), 'utf8'), new RegExp(`- stage store-dump: failed: owner decision, \\d{4}-\\d{2}-\\d{2}: ${words}`));

    // The --release copy carries the decision, so the published record shows it.
    const record = JSON.parse(readFileSync(join(reportsDir, '2099-06-04-9.9.10-release-gate.json'), 'utf8')) as { accepted: Record<string, { reason: string }> };
    assert.equal(record.accepted['store-dump: failed'].reason, words);
    assert.match(readFileSync(join(reportsDir, '2099-06-04-9.9.10-release-gate.md'), 'utf8'), /- stage store-dump: failed: owner decision/);

    // Carried through regeneration the way an accepted row is.
    const regenerated = buildReport(sitting, { reportsDir, releaseVersionOverride: '9.9.10' });
    assert.equal(regenerated.verdict, 'PASS');
    assert.equal(regenerated.accepted['store-dump: failed'].reason, words);
  });

  it('acceptRow refuses a blank reason on a stage reason, and refuses a name that is neither a row nor a stage', async () => {
    const { acceptRow, buildReport, persist, SITTING_REPORT } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('accept-stage-blank-sitting');
    fixtureSitting(sitting, '2099-06-05', [71, 71], failedStoreDump);
    const reportsDir = scratchDir('accept-stage-blank-reports');
    const mdPath = join(scratchDir('accept-stage-blank-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n<!-- /numbers -->\n`);
    persist(buildReport(sitting, { reportsDir }), { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });

    for (const blank of ['', '   ', '\n']) {
      assert.throws(() => acceptRow('store-dump: failed', blank, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath }), /needs a reason/, `a reason of ${JSON.stringify(blank)} must be refused`);
    }
    // The step id alone is not the stage reason: the status is part of what was accepted.
    assert.throws(() => acceptRow('store-dump', words, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath }), /neither a row nor a stage reason/);
    const stillBlocked = JSON.parse(readFileSync(join(sitting, `${SITTING_REPORT}.json`), 'utf8')) as { verdict: string; accepted: Record<string, unknown> };
    assert.equal(stillBlocked.verdict, 'BLOCK', 'a refused override must leave the verdict alone');
    assert.deepEqual(stillBlocked.accepted, {}, 'a refused override must record nothing');
  });
});

describe('benchmark release-gate: unmeasured work (an earlier failure, or an interruption) can never be accepted', () => {
  // The defect this guards: unmeasuredSteps()/interruptedSteps() went into the same stageReasons
  // array report.stage_reasons publishes, which is exactly what acceptRow validates --accept
  // against, so the real not-run/interrupted strings were themselves acceptable ids and --accept
  // could turn "this was never measured" into PASS. Both reasons must block unconditionally and
  // never appear in stage_reasons, so acceptRow refuses them as an unknown id, the same refusal it
  // gives any string that names nothing. Every reason asserted below is read off the real
  // exported functions, never hand-typed, so a wording change cannot make this pass by drift.
  it('a sitting owing three gates with store-dump failed and compare not-run blocks on both; accepting the failure leaves the not-run reason; the real not-run reason is refused by acceptRow', async () => {
    const { acceptRow, buildReport, failedStageReasons, persist, unmeasuredSteps } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('unmeasured-after-failure-sitting');
    const steps = { 'store-dump': { id: 'store-dump', status: 'failed' }, compare: { id: 'compare', status: 'not-run' } };
    const sittingJson = {
      date: '2099-06-06',
      baseline_version: '9.9.9',
      last_tag: 'v9.9.8',
      machine: { cpu_model: 'Fixture' },
      node: 'v99',
      changed_paths: ['src/x.ts'],
      owed: { baseline: ['src/x.ts'], scale: ['src/x.ts'], 'quality-baseline': ['src/x.ts'] },
      steps,
      failed_stage_reasons: failedStageReasons(steps),
    };
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson));
    const reportsDir = scratchDir('unmeasured-after-failure-reports');
    const mdPath = join(scratchDir('unmeasured-after-failure-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n${'<!-- /numbers -->'}\n`);

    const [notRunReason] = unmeasuredSteps(sittingJson);
    assert.equal(notRunReason, 'compare: not run (the gate stopped at an earlier failure); run the gate again to resume it', 'sanity: this is the real string the code produces');

    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK');
    assert.deepEqual([...report.verdict_reasons].sort(), [notRunReason, 'store-dump: failed'].sort());
    assert.deepEqual(report.stage_reasons, ['store-dump: failed'], 'the not-run reason is never in stage_reasons, so acceptRow can never find it as an id');
    persist(report, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });

    const afterAccept = acceptRow('store-dump: failed', 'the diff is the parser change the changelog names', { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    assert.equal(afterAccept.verdict, 'BLOCK', 'the unmeasured step still blocks once the stage failure is accepted');
    assert.deepEqual(afterAccept.verdict_reasons, [notRunReason]);

    assert.throws(() => acceptRow(notRunReason, 'trying anyway', { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath }), /neither a row nor a stage reason/, 'the real not-run string, not a truncation, must still be refused');
  });

  it('a real interrupted-step reason is refused by acceptRow the same way, and never appears in stage_reasons', async () => {
    const { acceptRow, buildReport, interruptedSteps, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('interrupted-not-acceptable-sitting');
    const sittingJson = { date: '2099-06-09', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: {}, failed_stage_reasons: [] };
    writeFileSync(join(sitting, 'battery-turso-hub.log'), 'partial output, then the kill\n'); // the log exists, the status never got written
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson));
    const reportsDir = scratchDir('interrupted-not-acceptable-reports');
    const mdPath = join(scratchDir('interrupted-not-acceptable-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n${'<!-- /numbers -->'}\n`);

    const [interruptedReason] = interruptedSteps(sitting, sittingJson);
    assert.match(interruptedReason, /^battery-turso-hub: started, never finished \(sitting interrupted\); run the gate again to resume it$/, 'sanity: this is the real string the code produces');

    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK');
    assert.deepEqual(report.verdict_reasons, [interruptedReason]);
    assert.deepEqual(report.stage_reasons, [], 'the interrupted reason is never in stage_reasons either');
    persist(report, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });

    assert.throws(() => acceptRow(interruptedReason, 'trying anyway', { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath }), /neither a row nor a stage reason/, 'the real interrupted string, not a truncation, must still be refused');
  });
});

describe('benchmark release-gate: generated report re-render is idempotent', () => {
  it('fixture: buildReport + persist is byte-identical to a second run against the same sitting', async () => {
    const { buildReport, persist } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('idempotent-fixture-sitting');
    fixtureSitting(sitting, '2099-06-03', [71, 71]);
    const reportsDir = scratchDir('idempotent-fixture-reports');
    const mdPath = join(scratchDir('idempotent-fixture-md'), 'BENCHMARKING.md');
    writeFileSync(mdPath, `# Benchmarks\n\n${'<!-- numbers -->'}\n\n<!-- /numbers -->\n`);
    const first = buildReport(sitting, { reportsDir });
    const { jsonPath, mdPath: reportMdPath } = persist(first, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    const jsonAfterFirst = readFileSync(jsonPath, 'utf8');
    const mdAfterFirst = readFileSync(reportMdPath, 'utf8');

    const second = buildReport(sitting, { reportsDir });
    persist(second, { sittingDir: sitting, reportsDir, benchmarkingMdPath: mdPath });
    assert.equal(readFileSync(jsonPath, 'utf8'), jsonAfterFirst, 'release-gate JSON must be byte-identical on re-render');
    assert.equal(readFileSync(reportMdPath, 'utf8'), mdAfterFirst, 'release-gate md must be byte-identical on re-render');
  });

  it('every generated release-gate md tracked in the tree is byte-identical to its regeneration', async () => {
    const reportsDir = join(packageRoot, 'benchmark', 'reports');
    const jsonFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => REPORT_JSON_RE.test(f)) : [];
    if (jsonFiles.length === 0) return; // no generated report has landed yet
    const { buildReport, persist } = await import('../../benchmark/report.mjs');
    for (const file of jsonFiles) {
      const report = JSON.parse(readFileSync(join(reportsDir, file), 'utf8')) as { generated?: boolean; date: string; package_version?: string; release_version?: string | null; sitting?: string; measure_version?: string };
      if (!report.generated) continue;
      if ((report.measure_version ?? 'm2') !== MEASURE_VERSION) continue; // classified by an older harness; its priors are refused now
      const sittingDate = report.date;
      const sittingsDir = join(packageRoot, '.tmp', 'sittings');
      // The report names its own sitting; older ones predate that and fall back to date + baseline.
      const candidates = existsSync(sittingsDir) ? readdirSync(sittingsDir).filter((d) => (report.sitting ? d === report.sitting : d.startsWith(`${sittingDate}-${report.package_version}`))) : [];
      if (candidates.length === 0) continue; // the sitting that produced this report was cleaned from .tmp
      const scratch = scratchDir('regen-check-reports');
      const rebuilt = buildReport(join(sittingsDir, candidates[0]), { reportsDir: join(packageRoot, 'benchmark', 'reports'), releaseVersionOverride: report.release_version ?? undefined });
      const scratchMd = join(scratchDir('regen-check-md'), 'BENCHMARKING.md');
      writeFileSync(scratchMd, readFileSync(join(packageRoot, 'BENCHMARKING.md'), 'utf8'));
      persist(rebuilt, { sittingDir: scratch, reportsDir: scratch, benchmarkingMdPath: scratchMd }); // never back into the real sitting
      const trackedMd = readFileSync(join(reportsDir, file.replace(/\.json$/, '.md')), 'utf8');
      const regeneratedMd = readFileSync(join(scratch, file.replace(/\.json$/, '.md')), 'utf8');
      assert.equal(regeneratedMd, trackedMd, `${file.replace(/\.json$/, '.md')} is not byte-identical to its regeneration`);
    }
  });
});
