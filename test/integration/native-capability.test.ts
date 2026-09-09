import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { open, STORE_NAMES } from 'sensemaking';
import { NATIVE_CAPABILITY_HARNESS_FILES, runNativeCapability } from '../../benchmark/lib/native-capability.mjs';
import { quietMachineCheck } from '../../benchmark/lib/quiet-machine.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { STORE_DIMS } from '../../src/embed/types.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';

type NativeArtifact = Awaited<ReturnType<typeof runNativeCapability>>;

import { forEachStore } from '../lib/stores.ts';

const DIAGONAL_SIMILARITY = Number(Math.SQRT1_2.toFixed(3));
const ONE_MIB = 1024 * 1024;
const FIXTURE_MTIME_MS = Date.parse('2100-01-01T00:00:00.000Z');
const LARGE_CONTENT_BODY = `other delta ${'x'.repeat(ONE_MIB - 1 - Buffer.byteLength('other delta '))}`;
const DENSE_A = 'needle needle needle needle needle needle needle needle alpha';
const DENSE_B = 'needle needle needle needle needle needle needle needle beta';

describe('native capability diagnostic', () => {
  it('runs cold, warm, content, and vector checks against every real store', async function () {
    this.timeout(60_000);
    const artifacts: Array<{ row_workload_ids: Record<string, string> }> = [];
    await forEachStore(async (store) => {
      const artifact = await runNativeCapability({
        open,
        store,
        storeNames: STORE_NAMES,
        root: scratchDir(`native-capability-${store}`),
        packageRoot,
        harnessRoot: packageRoot,
        storeDims: STORE_DIMS,
        notes: 4,
        repetitions: 3,
      });
      artifacts.push(artifact);
      assert.equal(artifact.valid, true, `${store}: authored native checks must pass`);
      assert.equal(artifact.samples.length, 3, `${store}: every repetition is retained`);
      assert.equal(artifact.store, store);
      assert.equal(artifact.implementation_stability.stable, true);
      assert.equal(identityHash(artifact.implementation_stability.before), identityHash(artifact.implementation_stability.after));
      assert.equal('store' in artifact.workload.inputs.requested, false, 'store is an implementation field, not a logical workload input');
      assert.equal(artifact.workload.inputs.requested.vector_dims, STORE_DIMS);
      assert.equal(artifact.workload.fingerprint, identityHash(artifact.workload.inputs));
      for (const sample of artifact.samples) {
        assert.ok(sample && typeof sample === 'object' && 'lexical' in sample && sample.lexical && 'vectors' in sample && sample.vectors && 'content' in sample && sample.content && 'manifests' in sample && sample.manifests, `${store}: repetition error: ${'error' in sample ? sample.error : 'missing sample fields'}`);
        const lexical = sample.lexical;
        const vectors = sample.vectors;
        const content = sample.content;
        const manifests = sample.manifests;
        assert.deepEqual(lexical.first_paths.slice().sort(), ['a.md', 'b.md']);
        assert.deepEqual(lexical.warm_paths.slice().sort(), ['a.md', 'b.md']);
        assert.deepEqual(
          vectors.candidates.map(({ path }: { path: string }) => path),
          ['a.md', 'b.md', 'c.md']
        );
        assert.deepEqual(
          vectors.candidates.map(({ path, similarity }: { path: string; similarity: number }) => [path, similarity]),
          [
            ['a.md', 1],
            ['b.md', DIAGONAL_SIMILARITY],
            ['c.md', 0],
          ]
        );
        assert.deepEqual(
          vectors.similar.map(({ path }: { path: string }) => path),
          ['b.md', 'c.md']
        );
        assert.deepEqual(
          vectors.similar.map(({ path, similarity }: { path: string; similarity: number }) => [path, similarity]),
          [
            ['b.md', DIAGONAL_SIMILARITY],
            ['c.md', 0],
          ]
        );
        assert.deepEqual(content.paths, ['a.md', 'd.md']);
        assert.deepEqual(sample.state, { tree: 'fresh', source_cache: 'warm', index: 'cold' });
        assert.deepEqual(vectors.pending_after, []);
        assert.deepEqual(
          vectors.pending_before.slice().sort((a: { path: string; chunk: number }, b: { path: string; chunk: number }) => a.path.localeCompare(b.path) || a.chunk - b.chunk),
          [
            { path: 'a.md', chunk: 0 },
            { path: 'b.md', chunk: 0 },
            { path: 'c.md', chunk: 0 },
            { path: 'd.md', chunk: 0 },
          ]
        );
        assert.equal(manifests.lexical.fingerprint, artifact.workload.inputs.corpus.lexical.fingerprint);
        assert.equal(manifests.vectors.fingerprint, artifact.workload.inputs.corpus.vectors.fingerprint);
      }
    });
    assert.equal(new Set(artifacts.map((artifact) => JSON.stringify(artifact.row_workload_ids))).size, 1, 'store is not part of logical row identity');
  });

  it('runs each named native workload axis with independent authored postconditions', async function () {
    this.timeout(120_000);
    for (const caseId of ['large-content', 'dense-terms', 'broad-matches', 'top-one', 'narrow-vectors', 'structured-content'] as const) {
      const notes = caseId === 'structured-content' ? 5 : 4;
      const artifacts: NativeArtifact[] = [];
      for (const store of STORE_NAMES) {
        const artifact = await runNativeCapability({
          open,
          store,
          storeNames: STORE_NAMES,
          root: scratchDir(`native-capability-${caseId}-${store}`),
          packageRoot,
          harnessRoot: packageRoot,
          storeDims: STORE_DIMS,
          notes,
          repetitions: 3,
          caseId,
        });
        artifacts.push(artifact);
        assert.equal(artifact.schema, 'native-capability-v3');
        assert.equal(artifact.case_id, caseId);
        assert.equal(artifact.notes, notes);
        assert.equal(artifact.valid, true, `${caseId}/${store}: authored native checks must pass`);
        assert.equal(artifact.samples.length, 3);
        const requested = artifact.workload.inputs.requested;
        assert.equal(requested.case_id, caseId);
        assert.equal(artifact.workload.inputs.axes.fixture_mtime_ms, FIXTURE_MTIME_MS);
        assert.equal(requested.native_schema_dims, STORE_DIMS);
        assert.equal(requested.vector_wire_dims, caseId === 'narrow-vectors' ? 64 : STORE_DIMS);
        assert.equal(artifact.workload.inputs.operation.vectors.wire_dims, requested.vector_wire_dims);
        assert.equal(artifact.workload.inputs.operation.vectors.native_schema_dims, STORE_DIMS);
        assert.equal(artifact.workload.inputs.operation.vectors.candidate_k, caseId === 'top-one' ? 1 : 3);
        assert.equal(artifact.workload.inputs.operation.vectors.similar_k, caseId === 'top-one' ? 1 : 2);
        const sample = artifact.samples[0];
        assert.ok(!('error' in sample));
        if ('error' in sample || !sample.lexical || !sample.vectors || !sample.content || !sample.manifests) throw new Error(`${caseId}/${store}: repetition did not return a complete observation`);
        const expectedLexical = caseId === 'broad-matches' ? ['a.md', 'b.md', 'c.md', 'd.md'] : ['a.md', 'b.md'];
        assert.deepEqual(sample.lexical.first_paths.slice().sort(), expectedLexical);
        assert.deepEqual(sample.lexical.warm_paths.slice().sort(), expectedLexical);
        const expectedCandidates =
          caseId === 'top-one'
            ? [{ path: 'a.md', similarity: 1 }]
            : [
                { path: 'a.md', similarity: 1 },
                { path: 'b.md', similarity: DIAGONAL_SIMILARITY },
                { path: 'c.md', similarity: 0 },
              ];
        const expectedSimilar =
          caseId === 'top-one'
            ? [{ path: 'b.md', similarity: DIAGONAL_SIMILARITY }]
            : [
                { path: 'b.md', similarity: DIAGONAL_SIMILARITY },
                { path: 'c.md', similarity: 0 },
              ];
        assert.deepEqual(sample.vectors.candidates, expectedCandidates);
        assert.deepEqual(sample.vectors.similar, expectedSimilar);
        assert.deepEqual(sample.vectors.pending_after, []);
        if (caseId === 'large-content') {
          assert.equal(Buffer.byteLength(`${LARGE_CONTENT_BODY}\n`), ONE_MIB);
          assert.ok(LARGE_CONTENT_BODY.startsWith('other delta '));
          assert.equal(LARGE_CONTENT_BODY.endsWith('x'), true);
          assert.equal(sample.content.rows.find((row: { path: string }) => row.path === 'd.md')?.text_hash, identityHash(LARGE_CONTENT_BODY));
          assert.equal(sample.manifests.lexical.bytes, ONE_MIB + Buffer.byteLength('needle alpha\n') + Buffer.byteLength('needle beta\n') + Buffer.byteLength('other gamma\n'));
        }
        if (caseId === 'dense-terms') {
          assert.equal(sample.content.rows.find((row: { path: string }) => row.path === 'a.md')?.text_hash, identityHash(DENSE_A));
          assert.equal(sample.content.rows.find((row: { path: string }) => row.path === 'd.md')?.text_hash, identityHash(`other delta ${Array.from({ length: 64 }, (_, i) => `large-${i}`).join(' ')}`));
          assert.equal(DENSE_A.split(' ').filter((term) => term === 'needle').length, 8);
          assert.equal(DENSE_B.split(' ').filter((term) => term === 'needle').length, 8);
        }
        if (caseId === 'structured-content') {
          const expectedFivePaths = ['a.md', 'b.md', 'c.md', 'd.md', 'filler-001.md'];
          for (const manifest of [sample.manifests.lexical, sample.manifests.vectors]) {
            assert.equal(manifest.files, 5);
            assert.equal(manifest.paths_fingerprint, identityHash(expectedFivePaths));
          }
          assert.equal(artifact.workload.inputs.operation.content.sql, 'SELECT "path", title, summary, text FROM content WHERE "path" = ?');
          assert.deepEqual(sample.content.rows, [
            { path: 'a.md', title_hash: identityHash('Alpha'), summary_hash: identityHash(''), text_hash: identityHash('Alpha needle alpha See b.') },
            { path: 'd.md', title_hash: identityHash('Delta'), summary_hash: identityHash(''), text_hash: identityHash('Delta other delta') },
          ]);
          assert.deepEqual(sample.structured, {
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
          });
        }
      }
      assert.equal(new Set(artifacts.map((artifact) => artifact.workload.fingerprint)).size, 1, `${caseId}: stores must share one logical workload`);
      assert.equal(new Set(artifacts.map((artifact) => JSON.stringify(artifact.row_workload_ids))).size, 1, `${caseId}: store is not part of logical row identity`);
    }
  });

  it('invalidates measurements when copied same-tree implementation evidence changes mid-run', async function () {
    this.timeout(60_000);
    const sandbox = scratchDir('native-capability-drift');
    cpSync(join(packageRoot, 'package.json'), join(sandbox, 'package.json'));
    cpSync(join(packageRoot, 'src'), join(sandbox, 'src'), { recursive: true });
    cpSync(join(packageRoot, 'dist'), join(sandbox, 'dist'), { recursive: true });
    for (const relative of NATIVE_CAPABILITY_HARNESS_FILES) {
      const target = join(sandbox, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(join(packageRoot, relative), target);
    }
    let changed = false;
    const openAndChangeCopiedHarness: typeof open = async (cfg) => {
      const opened = await open(cfg);
      if (!changed) {
        appendFileSync(join(sandbox, 'benchmark/lib/native-capability.mjs'), '\n// copied fixture drift\n');
        changed = true;
      }
      return opened;
    };
    const artifact = await runNativeCapability({
      open: openAndChangeCopiedHarness,
      store: 'sqlite',
      storeNames: STORE_NAMES,
      root: scratchDir('native-capability-drift-trees'),
      packageRoot: sandbox,
      harnessRoot: sandbox,
      storeDims: STORE_DIMS,
      notes: 4,
      repetitions: 3,
    });
    assert.equal(artifact.implementation_stability.stable, false);
    assert.equal(artifact.valid, false);
    assert.match(artifact.errors.join('\n'), /implementation identity changed during native capability measurement/);
  });

  it('prints the full artifact when no output path is supplied', () => {
    const result = spawnSync(process.execPath, [join(packageRoot, 'benchmark/tools/native-capability.mjs'), '--store', 'sqlite'], { cwd: packageRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message ?? 'native CLI spawn failed');
    assert.equal(result.signal, null, `CLI was signaled: ${result.signal}`);
    assert.ok(result.status === 0 || result.status === 1, `unexpected CLI status ${result.status}: ${result.stderr}`);
    const artifact = JSON.parse(result.stdout);
    assert.equal(artifact.schema, 'native-capability-v3');
    assert.equal(artifact.store, 'sqlite');
    assert.equal(artifact.case_id, 'baseline');
    if (result.status === 0) {
      assert.equal(artifact.valid, true);
      assert.equal(artifact.timing.valid, true);
      assert.equal(artifact.samples.length, 3);
      assert.ok(artifact.workload);
      assert.equal(artifact.workload.inputs.requested.case_id, 'baseline');
      assert.equal(artifact.readiness.entry.passed, true);
      assert.equal(artifact.readiness.exit.passed, true);
      assert.deepEqual(artifact.readiness.environment.entry, artifact.implementation_stability.before.environment);
      assert.deepEqual(artifact.readiness.environment.exit, artifact.implementation_stability.after.environment);
      assert.match(artifact.environment.machine.hostname_sha256, /^[0-9a-f]{64}$/);
      assert.equal('hostname' in artifact.environment.machine, false);
    } else {
      assert.equal(artifact.timing.valid, false);
      assert.equal(typeof artifact.timing.error, 'string');
      if (artifact.status === 'refused-preflight') {
        assert.equal(artifact.valid, false);
        assert.equal(artifact.timing.exit, null);
        assert.equal(artifact.readiness.entry.passed, false);
        assert.equal(artifact.readiness.exit, null);
        if (artifact.readiness.entry.supported) assert.equal(quietMachineCheck(artifact.timing.entry.load1, cpus().length).blocked, true);
      } else {
        assert.equal(artifact.valid, true, `unexpected correctness failure: ${JSON.stringify(artifact.errors)}`);
        assert.equal(quietMachineCheck(artifact.timing.exit.load1, cpus().length).blocked, true);
      }
    }
  });
});
