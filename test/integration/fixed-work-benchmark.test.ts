import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { open } from 'sensemaking';
import { FIXED_HYDRATION_CANDIDATES, FIXED_HYDRATION_CASES, FIXED_HYDRATION_EXPECTED, FIXED_HYDRATION_FILES, FIXED_HYDRATION_LINES, FIXED_HYDRATION_SECTIONS, FIXED_HYDRATION_TERMS } from '../../benchmark/lib/fixed-hydration-workload.mjs';
import { compareNativeHydrationArtifacts } from '../../benchmark/lib/native-hydration-compare.mjs';
import { validateSharedSnippetArtifact } from '../../benchmark/lib/shared-snippet-contract.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { computeSnippets, hydrateSearchRows, lineNumberAt } from '../../src/commands/search.ts';
import type { ResolvedConfig } from '../../src/config/types.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore } from '../lib/stores.ts';

type HydrationRow = { path: string; snippets?: string[]; lines?: string };

function runTool(args: string[], out: string): { artifact: Record<string, unknown>; status: number | null } {
  const result = spawnSync(process.execPath, [...args, '--out', out], { cwd: packageRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message ?? 'tool spawn failed');
  assert.equal(result.signal, null, `tool was terminated by ${result.signal}`);
  assert.ok(result.status === 0 || result.status === 1, result.stderr || result.stdout);
  return { artifact: JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>, status: result.status };
}

type MutableHydrationArtifact = {
  workload: { inputs: { files: Record<string, { sha256: string }> }; fingerprint: string };
  expected: { rows_by_case: { default: Record<string, { snippets: string[] }> } };
};

describe('fixed-work benchmark artifacts', () => {
  it('checks every authored snippet and line before timing can qualify', () => {
    const denseWords = FIXED_HYDRATION_FILES['d.md'].trim().split(/\s+/);
    assert.ok(denseWords.length > 250_000, 'the dense large note must exercise at least 250,000 word boundaries');
    assert.ok(
      denseWords.every((word) => word.length < 20),
      'a single giant word is not the dense-word workload'
    );
    for (const { id, char_limit: charLimit, count_limit: countLimit } of FIXED_HYDRATION_CASES) {
      for (const path of FIXED_HYDRATION_CANDIDATES) {
        const text = FIXED_HYDRATION_FILES[path as keyof typeof FIXED_HYDRATION_FILES];
        const result = computeSnippets(text, FIXED_HYDRATION_TERMS, charLimit, countLimit);
        assert.deepEqual(result.snippets, FIXED_HYDRATION_EXPECTED[id as keyof typeof FIXED_HYDRATION_EXPECTED][path as keyof typeof FIXED_HYDRATION_LINES].snippets, `${id} ${path}`);
        assert.equal(lineNumberAt(text, result.offset), FIXED_HYDRATION_LINES[path as keyof typeof FIXED_HYDRATION_LINES], `${id} ${path} line`);
      }
    }
    assert.equal(Buffer.byteLength(FIXED_HYDRATION_FILES['d.md']), 1024 * 1024);
  });

  it('hydrates the identical fixed candidates through every real store', async function () {
    this.timeout(60_000);
    await forEachStore(async (storeName) => {
      const tree = scratchDir(`fixed-hydration-${storeName}`);
      for (const [path, text] of Object.entries(FIXED_HYDRATION_FILES)) writeFileSync(join(tree, path), text);
      const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir: tree, configPath: null, store: storeName } as ResolvedConfig;
      const opened = await open(cfg);
      try {
        const sections = {} as Record<string, string | string[]>;
        for (const path of FIXED_HYDRATION_CANDIDATES) {
          const found = ((await (await opened.store.prepare('SELECT start_line, end_line FROM sections WHERE "path" = ? ORDER BY start_line')).all(path)) as Array<{ start_line: number; end_line: number }>).map((row) => `L${row.start_line}-${row.end_line}`);
          sections[path] = found.length === 1 ? found[0] : found;
        }
        assert.deepEqual(sections, FIXED_HYDRATION_SECTIONS, `${storeName} sections`);
        for (const { id, char_limit: snippetCharLimit, count_limit: snippetCountLimit } of FIXED_HYDRATION_CASES) {
          const rows: HydrationRow[] = FIXED_HYDRATION_CANDIDATES.map((path) => ({ path }));
          await hydrateSearchRows(opened.store, cfg, rows, new Set(FIXED_HYDRATION_CANDIDATES), FIXED_HYDRATION_TERMS[0], { snippetCharLimit, snippetCountLimit });
          assert.deepEqual(Object.fromEntries(rows.map((row) => [row.path, { snippets: row.snippets, lines: row.lines }])), FIXED_HYDRATION_EXPECTED[id as keyof typeof FIXED_HYDRATION_EXPECTED], `${storeName} ${id}`);
        }
      } finally {
        await opened.store.close();
      }
    });
  });

  it('runs validity artifacts before the release comparison without adding timing rows', () => {
    const baseline = buildStages().find(({ id }) => id === 'baseline');
    assert.deepEqual(
      baseline?.steps.slice(0, 5).map(({ id }) => id),
      ['shared-snippet', 'native-hydration-sqlite', 'native-hydration-duckdb', 'native-hydration-turso', 'native-hydration-comparison']
    );
    assert.equal(baseline?.steps[5]?.id, 'result-sets-hub');
    assert.equal(baseline?.steps[6]?.id, 'compare');
    assert.deepEqual(
      baseline?.steps.filter(({ id }) => id.startsWith('result-sets-')),
      [{ id: 'result-sets-hub', argv: ['node', 'benchmark/tools/result-sets.mjs', 'obsidian-hub'], timeout: 15 * 60_000, quiet: false, owedBy: 'baseline', out: true }]
    );
    assert.ok(baseline?.steps.slice(0, 4).every((step) => step.quiet && 'out' in step && step.out));
    assert.equal(baseline?.steps[4].quiet, false);

    const scale = buildStages().find(({ id }) => id === 'scale');
    assert.equal(scale?.steps[0]?.id, 'result-sets-stress');
    assert.equal(scale?.steps[1]?.id, 'scale-13k');
    assert.deepEqual(
      scale?.steps.filter(({ id }) => id.startsWith('result-sets-')),
      [{ id: 'result-sets-stress', argv: ['node', 'benchmark/tools/result-sets.mjs', '.tmp/cache/stress-stress-1'], timeout: 15 * 60_000, quiet: false, owedBy: 'scale', out: true }]
    );
  });

  it('measures shared snippet work once against its authored output', () => {
    const out = join(scratchDir('shared-snippet-tool'), 'artifact.json');
    const { artifact, status } = runTool([join(packageRoot, 'benchmark/tools/shared-snippet.mjs')], out);
    if (status === 0) validateSharedSnippetArtifact(artifact);
    else assert.match(String((artifact.errors as string[])[0]), /quiet-machine preflight refused/);
  });

  it('compares exact production hydration of one fixed candidate sequence across real stores', () => {
    const dir = scratchDir('native-hydration-tools');
    const observed = ['sqlite', 'duckdb', 'turso'].map((store) => runTool([join(packageRoot, 'benchmark/tools/native-hydration.mjs'), '--store', store], join(dir, `native-hydration-${store}.json`)));
    if (observed.some(({ status }) => status !== 0)) {
      for (const { artifact, status } of observed) if (status !== 0) assert.match((artifact.errors as string[]).join('\n'), /quiet-machine preflight refused|readiness lost/);
      return;
    }
    const artifacts = observed.map(({ artifact }) => artifact);
    const comparison = compareNativeHydrationArtifacts(artifacts);
    assert.equal(comparison.valid, true, comparison.errors.join('\n'));
    assert.deepEqual(comparison.stores, ['duckdb', 'sqlite', 'turso']);
    assert.deepEqual(Object.keys(comparison.samples_ms_by_store).sort(), ['duckdb', 'sqlite', 'turso']);
    assert.match(comparison.scope, /excludes ranking/);
    const cliOut = join(dir, 'native-hydration-comparison.json');
    const cli = runTool([join(packageRoot, 'benchmark/tools/native-hydration-compare.mjs')], cliOut);
    assert.equal(cli.status, 0);
    assert.deepEqual(cli.artifact, comparison);

    const mixedVersion = structuredClone(artifacts);
    mixedVersion[1].measure_version = 'fixture-old';
    const invalid = compareNativeHydrationArtifacts(mixedVersion);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join('\n'), /duckdb: measure_version fixture-old does not match current/);

    for (const [label, mutate] of [
      [
        'same-count wrong path',
        (value: MutableHydrationArtifact) => {
          value.workload.inputs.files['wrong.md'] = value.workload.inputs.files['a.md'];
          delete value.workload.inputs.files['a.md'];
        },
      ],
      [
        'changed note bytes',
        (value: MutableHydrationArtifact) => {
          value.workload.inputs.files['a.md'].sha256 = '0'.repeat(64);
        },
      ],
      [
        'changed output',
        (value: MutableHydrationArtifact) => {
          value.expected.rows_by_case.default['a.md'].snippets = ['wrong'];
        },
      ],
    ] as const) {
      const changed = structuredClone(artifacts);
      const changedArtifact = changed[0] as MutableHydrationArtifact;
      mutate(changedArtifact);
      changedArtifact.workload.fingerprint = identityHash(changedArtifact.workload.inputs);
      const result = compareNativeHydrationArtifacts(changed);
      assert.equal(result.valid, false, label);
      assert.match(result.errors.join('\n'), /fixed workload mismatch|authored expected output mismatch/, label);
    }
  });

  it('rejects changed candidate identity and incomplete store coverage', () => {
    const dir = scratchDir('native-hydration-invalid');
    const run = runTool([join(packageRoot, 'benchmark/tools/native-hydration.mjs'), '--store', 'sqlite'], join(dir, 'sqlite.json'));
    if (run.status !== 0) {
      assert.match((run.artifact.errors as string[]).join('\n'), /quiet-machine preflight refused|readiness lost/);
      return;
    }
    const sqlite = run.artifact;
    const changed = structuredClone(sqlite) as { store: string; samples: Array<{ candidate_order: string[] }> };
    changed.store = 'duckdb';
    changed.samples[0].candidate_order = ['a.md', 'b.md', 'c.md'];
    const comparison = compareNativeHydrationArtifacts([sqlite, changed]);
    assert.equal(comparison.valid, false);
    assert.match(comparison.errors.join('\n'), /candidate order mismatch|store set/);
    assert.equal('samples_ms_by_store' in comparison, false);
  });
});
