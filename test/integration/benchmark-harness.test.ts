import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { search } from 'sensemaking';
import { classify } from '../../benchmark/lib/classify.mjs';
import { runStageSteps } from '../../benchmark/lib/gate-runner.mjs';
import { DIFF_MAP_PATHS, GATE_NAMES, owedReasons, reversedCompareAction, stepStatus } from '../../benchmark/lib/gates.mjs';
import { MEASURE_VERSION, structuredSearchEvidence, timedCli, verbsFrom, warmFileCache } from '../../benchmark/lib/measure.mjs';
import { startMeasuredWatcher } from '../../benchmark/lib/measured-watcher.mjs';
import { nativeObserverAttemptBudgetMs, nativeObserverDeadlineMs, runNativeObserverAttempt, waitForNativeIndex } from '../../benchmark/lib/native-observer.mjs';
import { buildQualityArtifactBase, evaluateVariant, queryFormFor } from '../../benchmark/lib/quality.mjs';
import { describeLoad, parseTopProcesses, quietMachineCheck } from '../../benchmark/lib/quiet-machine.mjs';
import { INPROC_META_KEYS, ROW_BY_KEY, RUN_META_KEYS, RUN_METRIC_KEYS, rowValue } from '../../benchmark/lib/rows.mjs';
import { buildStages } from '../../benchmark/lib/stages.mjs';
import { captureIdentity, compareCaptureDirectories, structuredRows } from '../../benchmark/lib/store-dump-evidence.mjs';
import { treeFingerprint } from '../../benchmark/lib/tree-fingerprint.mjs';
import { aggregateVerdict, classificationSeverity, classifyCompare, classifyCrossGroup, classifyEval, classifyWatchSanity, priorStepLookup, shouldRunReversedCompare, watchSanityGroup } from '../../benchmark/lib/verdict.mjs';
import {
  applyDeterministicMutation,
  captureFileManifest,
  captureMutationFiles,
  deterministicMutationMtime,
  ephemeralWorkTree,
  fileManifestFingerprint,
  indexSnapshotMismatch,
  openVerified,
  readIndexSnapshot,
  verifyContentTransition,
  verifyFileManifest,
  verifyIndexSnapshot,
  verifyRepeatFingerprint,
} from '../../benchmark/lib/work-tree.mjs';
import { identityHash } from '../../benchmark/lib/workload-identity.mjs';
import { acceptanceFingerprint, acceptedIds, buildReport, classificationEvidence, doneOnResume, renderMarkdown } from '../../benchmark/report.mjs';
import { gate } from '../lib/gate.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore, openTreeForStore } from '../lib/stores.ts';
import { openConfig, writeNote } from '../lib/tree.ts';

// benchmark-harness.test.ts: the release-gate instrument's own behavior (classification,
// the diff map, the catalog/run.mjs contract), not sensemaking's product behavior -- see
// testing-standards on why this spans modules and lives here rather than in test/unit/.

const WALL_ROW = { key: 'cold_crawl_ms', label: 'cold crawl (wall)', kind: 'wall', band: 0.2, cross: 0.2 };
const TOKENS_ROW = { key: 'map_tokens', label: '`map` token count', kind: 'tokens' };
const QUALITY_ROW = { key: 'ndcg', label: 'nDCG@10', kind: 'quality' };
type SearchTerms = Parameters<typeof search>[2];
type SearchOptions = NonNullable<Parameters<typeof search>[3]>;

function identifiedRun<T extends object>(record: T): T & { workload_identity: { logical_inputs: { rows: Record<string, unknown> } } } {
  const rows = Object.fromEntries(
    RUN_METRIC_KEYS.map((key) => {
      const inputs = { fixture: 'release-comparison', row: key };
      return [key, { inputs, fingerprint: identityHash(inputs) }];
    })
  );
  return { ...record, workload_identity: { logical_inputs: { rows } } };
}

describe('timedCli: every repetition is part of validity', () => {
  const childRuns = (failedRun: number) => {
    let run = 0;
    return () => {
      run++;
      return spawnSync(process.execPath, ['-e', `if (${run} === ${failedRun}) { console.error("child-${failedRun}"); process.exit(7); }`], { encoding: 'utf8' });
    };
  };

  for (const failedRun of [1, 2, 3]) {
    it(`keeps a child failure when it occurs on repetition ${failedRun}`, () => {
      const result = timedCli(childRuns(failedRun), 3);
      assert.equal(result.ms, null);
      assert.equal(result.status, 7);
      assert.equal(result.repetitions.length, 3);
      assert.equal(result.repetitions[failedRun - 1].status, 7);
      assert.ok(result.repetitions.every((repetition) => Number.isFinite(repetition.elapsed_ms) && repetition.elapsed_ms >= 0));
      assert.match(result.error?.message ?? '', new RegExp(`run ${failedRun}:`));
      assert.match(result.stderr, new RegExp(`child-${failedRun}`));
    });
  }

  it('records a thrown runner as an invalid repetition', () => {
    const result = timedCli(() => {
      throw new Error('runner exploded');
    }, 1);
    assert.equal(result.ms, null);
    assert.equal(result.status, null);
    assert.equal(result.repetitions[0].error, 'Error: runner exploded');
    assert.ok(Number.isFinite(result.repetitions[0].elapsed_ms));
    assert.match(result.error?.message ?? '', /run 1: Error: runner exploded/);
  });

  it('records a signaled child as an invalid repetition', () => {
    const result = timedCli(() => spawnSync(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], { encoding: 'utf8' }), 1);
    assert.equal(result.ms, null);
    if (process.platform === 'win32') {
      assert.notEqual(result.status, 0);
      assert.equal(result.repetitions[0].signal, null);
      assert.match(result.error?.message ?? '', /status 1/);
    } else {
      assert.equal(result.status, null);
      assert.equal(result.repetitions[0].signal, 'SIGTERM');
      assert.match(result.error?.message ?? '', /SIGTERM/);
    }
    assert.ok(Number.isFinite(result.repetitions[0].elapsed_ms));
  });

  it('records exact bounded stdout evidence after timing without changing legacy code-unit bytes', () => {
    const text = 'é😀';
    const result = timedCli(() => spawnSync(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], { encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024 }), 1);
    const repetition = result.repetitions[0];
    assert.equal(repetition.bytes, text.length);
    assert.equal(repetition.stdout_utf16_code_units, text.length);
    assert.equal(repetition.stdout_utf8_bytes, Buffer.byteLength(text));
    assert.equal(repetition.stdout_sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(repetition.stdout_text_status, 'recorded');
    assert.equal(repetition.stdout, text);
  });

  it('omits oversized stdout text while retaining its exact digest and sizes', () => {
    const bytes = 64 * 1024 + 1;
    const result = timedCli(() => spawnSync(process.execPath, ['-e', `process.stdout.write('x'.repeat(${bytes}))`], { encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024 }), 1);
    const repetition = result.repetitions[0];
    assert.equal(repetition.bytes, bytes);
    assert.equal(repetition.stdout_utf8_bytes, bytes);
    assert.equal(repetition.stdout_sha256, createHash('sha256').update('x'.repeat(bytes)).digest('hex'));
    assert.equal(repetition.stdout_text_status, 'omitted-over-limit');
    assert.ok(!('stdout' in repetition));
  });

  it('keeps structured search evidence tied to the JSON invocation that produced it', () => {
    const stdout = JSON.stringify([
      { path: 'b.md', via: 'match', snippets: ['second'] },
      { path: 'a.md', via: 'vector', snippets: ['first', 'extra'] },
    ]);
    assert.deepEqual(structuredSearchEvidence(stdout), {
      paths: ['b.md', 'a.md'],
      via: ['match', 'vector'],
      snippet_sha256: [[createHash('sha256').update('second').digest('hex')], [createHash('sha256').update('first').digest('hex'), createHash('sha256').update('extra').digest('hex')]],
    });
    assert.throws(() => structuredSearchEvidence('[{"via":"match"}]'), /no nonempty string path/);
    assert.throws(() => structuredSearchEvidence('[{"path":""}]'), /no nonempty string path/);
    assert.throws(() => structuredSearchEvidence('[{"path":"a.md"},{"path":"a.md"}]'), /duplicate paths/);
    assert.deepEqual(structuredSearchEvidence('[{"path":"legacy.md","hit":"old snippet"},{"path":"unknown.md","snippet":"unknown shape"}]').snippet_sha256, [[createHash('sha256').update('old snippet').digest('hex')], null]);
  });

  it('retains exact stdout evidence when the child exits unsuccessfully', () => {
    const result = timedCli(() => spawnSync(process.execPath, ['-e', 'process.stdout.write("partial"); process.exit(9)'], { encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024 }), 1);
    assert.equal(result.ms, null);
    assert.equal(result.repetitions[0].status, 9);
    assert.equal(result.repetitions[0].stdout, 'partial');
    assert.equal(result.repetitions[0].stdout_sha256, createHash('sha256').update('partial').digest('hex'));
  });
});

describe('classify: band edges', () => {
  it('exactly at the band, either sign, is flat', () => {
    assert.equal(classify(WALL_ROW, 100, 120).verdict, 'flat');
    assert.equal(classify(WALL_ROW, 100, 80).verdict, 'flat');
  });

  it('one unit beyond the band with no reversed run: moved slower, faster faster', () => {
    assert.equal(classify(WALL_ROW, 100, 120.01).verdict, 'moved');
    assert.equal(classify(WALL_ROW, 100, 79.99).verdict, 'faster');
  });

  it('no prior recorded is no-prior, not a block', () => {
    const c = classify(WALL_ROW, null, 100);
    assert.equal(c.verdict, 'no-prior');
  });
});

describe('classify: faster verdict', () => {
  it('beyond band, faster, is its own verdict and never blocks', () => {
    const c = classify(WALL_ROW, 1000, 600);
    assert.equal(c.verdict, 'faster');
    const { verdict, reasons } = aggregateVerdict([{ id: 'row', context: 'compare', ...c }], []);
    assert.equal(verdict, 'PASS');
    assert.deepEqual(reasons, []);
  });

  it('beyond band, slower, stays moved', () => {
    const c = classify(WALL_ROW, 1000, 1400);
    assert.equal(c.verdict, 'moved');
  });
});

describe('quiet machine: the gate names what is keeping it busy', () => {
  const PS = ['%CPU COMM', ' 73.0 /System/Library/PrivateFrameworks/Ecosystem.framework/Support/ecosystemd', ' 40.0 /Users/x/.nvm/versions/node/bin/node', '  2.0 /usr/sbin/cupsd'].join('\n');

  it('blocks above half the cores and passes at the limit', () => {
    assert.equal(quietMachineCheck(7, 14).blocked, false, 'exactly at the limit is quiet');
    assert.equal(quietMachineCheck(7.01, 14).blocked, true);
    assert.equal(quietMachineCheck(1, 2).blocked, false, 'the limit scales with the machine');
    assert.equal(quietMachineCheck(1.01, 2).blocked, true);
  });

  it('reports the busiest processes and drops the quiet ones', () => {
    const top = parseTopProcesses(PS);
    assert.deepEqual(
      top.map((p) => p.percent),
      [73, 40],
      'cupsd at 2% is below the reporting floor'
    );
    assert.equal(top[0].system, true, "a /System/ path is not the reader's to stop");
    assert.equal(top[1].system, false, 'a node process under /Users is');
  });

  it('tells a blocked reader what to stop, and says so when nothing is theirs', () => {
    const mine = describeLoad(12, 14, parseTopProcesses(PS));
    assert.equal(mine.blocked, true);
    assert.match(mine.text, /stop these and run again: node/);
    const systemOnly = describeLoad(
      12,
      14,
      parseTopProcesses(PS).filter((p) => p.system)
    );
    assert.match(systemOnly.text, /nothing here is yours to stop/, 'a machine busy with its own daemons needs waiting, not a hunt');
    assert.doesNotMatch(describeLoad(2, 14, []).text, /exceeds/, 'a quiet machine says so plainly');
  });
});

describe('treeFingerprint: hashes content, not filenames or status letters', () => {
  const untracked = (path: string, text: string) => [{ path, bytes: Buffer.from(text) }];

  it('the same head with two different diffs produces two different keys', () => {
    const a = treeFingerprint({ head: 'abc', diff: 'diff a', untracked: [] });
    const b = treeFingerprint({ head: 'abc', diff: 'diff b', untracked: [] });
    assert.notEqual(a, b);
  });

  it('identical inputs produce the same key twice', () => {
    const inputs = { head: 'abc', diff: 'diff a', untracked: untracked('x.md', 'hello') };
    assert.equal(treeFingerprint(inputs), treeFingerprint(inputs));
  });

  it('an untracked file whose bytes change produces a different key', () => {
    const a = treeFingerprint({ head: 'abc', diff: '', untracked: untracked('x.md', 'hello') });
    const b = treeFingerprint({ head: 'abc', diff: '', untracked: untracked('x.md', 'goodbye') });
    assert.notEqual(a, b);
  });
});

describe('warmFileCache: every timed row measures the same cache state', () => {
  it('reads every indexed file, so a sitting never pays disk reads the next one does not', () => {
    const tree = scratchDir('warmup-tree');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'a.md'), 'aaaa');
    writeFileSync(join(tree, 'sub', 'b.md'), 'bbbbbb');
    writeFileSync(join(tree, 'ignored.txt'), 'not markdown');
    assert.equal(warmFileCache(tree), 10, 'every .md byte is read, and nothing else is');
  });

  it('cold_crawl_ms gates cross-sitting again, now the measurement is consistent', () => {
    const row = ROW_BY_KEY.get('cold_crawl_ms');
    assert.ok(row, 'cold_crawl_ms must exist in the catalog');
    assert.ok(typeof row.cross === 'number', 'a warmed measurement carries an ordinary band');
  });
});

describe('in-process benchmark repetitions: canonical filesystem and index state', () => {
  it('rejects same-size content changes, wrong same-count paths and extra paths', () => {
    const changed = scratchDir('repeat-manifest-content');
    writeFileSync(join(changed, 'a.md'), 'aaaa');
    const changedManifest = captureFileManifest(changed);
    writeFileSync(join(changed, 'a.md'), 'bbbb');
    const changedAfterWrite = captureFileManifest(changed);
    const sameMetadata = [{ ...changedManifest[0], mtimeMs: changedAfterWrite[0].mtimeMs }];
    assert.throws(() => verifyFileManifest(changed, sameMetadata), /sha256 mismatch/);

    const wrong = scratchDir('repeat-manifest-path');
    writeFileSync(join(wrong, 'a.md'), 'a');
    const wrongManifest = captureFileManifest(wrong);
    renameSync(join(wrong, 'a.md'), join(wrong, 'b.md'));
    assert.throws(() => verifyFileManifest(wrong, wrongManifest), /unexpected path: b\.md/);

    const extra = scratchDir('repeat-manifest-extra');
    writeFileSync(join(extra, 'a.md'), 'a');
    const extraManifest = captureFileManifest(extra);
    writeFileSync(join(extra, 'b.md'), 'b');
    assert.throws(() => verifyFileManifest(extra, extraManifest), /unexpected path: b\.md/);
  });

  it('fresh copies of one automatic source have byte-identical manifests', () => {
    const source = scratchDir('repeat-copy-source');
    writeFileSync(join(source, 'a.md'), 'automatic timestamp');
    const sourceManifest = captureFileManifest(source);
    const fingerprints: string[] = [];
    for (let repetition = 0; repetition < 5; repetition++) {
      const copy = ephemeralWorkTree(join(packageRoot, '.tmp', 'test'), 'repeat-copy-', source);
      try {
        const manifest = captureFileManifest(copy);
        fingerprints.push(fileManifestFingerprint(manifest));
      } finally {
        safeRmSync(copy, { recursive: true, force: true });
      }
    }
    assert.equal(new Set(fingerprints).size, 1);
    verifyFileManifest(source, sourceManifest, 'source after fresh copies');
    assert.equal(existsSync(join(source, '.sense')), false);
    assert.equal(existsSync(join(source, 'sense.config.json')), false);
  });

  it('rejects junction symlinks at the tree root and in a write path', () => {
    const tree = scratchDir('repeat-symlink');
    const target = join(tree, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'a.md'), 'canonical');
    const targetManifest = captureFileManifest(target);
    const targetMutation = captureMutationFiles(target, targetManifest, ['a.md']);
    const rootLink = join(tree, 'root-link');
    symlinkSync(target, rootLink, 'junction');
    assert.throws(() => captureMutationFiles(rootLink, targetManifest, ['a.md']), /tree root is a symlink/);

    const parentLink = join(tree, 'parent-link');
    symlinkSync(target, parentLink, 'junction');
    const parentManifest = targetManifest.map((entry: { rel: string }) => ({ ...entry, rel: `parent-link/${entry.rel}` }));
    const parentMutation = targetMutation.map((entry: { rel: string }) => ({ ...entry, rel: `parent-link/${entry.rel}` }));
    assert.throws(() => applyDeterministicMutation(tree, parentManifest, parentMutation, { append: null, mtimeMs: deterministicMutationMtime(parentManifest) }), /contains a symlink/);
  });

  it('runs two identical fresh-copy mtime and append repetitions on every real store', async () => {
    await forEachStore(async (store) => {
      const source = scratchDir(`repeat-${store}-source`);
      writeNote(source, 'a.md', { frontmatter: { title: 'Alpha', summary: 'Short', private: 'frontmatter-only' }, body: 'Plain benchmark-edit body.' });
      writeNote(source, 'unicode-漢.md', { frontmatter: { title: 'Unicode', summary: 'Second', private: 'also-frontmatter-only' }, body: 'Second plain body.' });
      const sourceManifest = captureFileManifest(source);
      const expectedContent = new Map([
        ['a.md', { title: 'Alpha', summary: 'Short', text: 'Plain benchmark-edit body.' }],
        ['unicode-漢.md', { title: 'Unicode', summary: 'Second', text: 'Second plain body.' }],
      ]);
      const { manifest, canonicalIndex } = await (async () => {
        const firstCopy = ephemeralWorkTree(join(packageRoot, '.tmp', 'test'), `repeat-${store}-canonical-`, source);
        try {
          const manifest = captureFileManifest(firstCopy);
          const open = () => openTreeForStore(store, firstCopy);
          const canonicalIndex = await openVerified(open, null, manifest, { label: 'authored canonical index', expectedContent });
          return { manifest, canonicalIndex };
        } finally {
          safeRmSync(firstCopy, { recursive: true, force: true });
        }
      })();
      const mtimeMs = deterministicMutationMtime(manifest);
      const fileFingerprints: string[] = [];
      const indexFingerprints: string[] = [];

      for (let repetition = 0; repetition < 2; repetition++) {
        const touchedTree = ephemeralWorkTree(join(packageRoot, '.tmp', 'test'), `repeat-${store}-touch-`, source);
        try {
          verifyFileManifest(touchedTree, manifest, 'mtime repetition input');
          const open = () => openTreeForStore(store, touchedTree);
          const baseline = await openVerified(open, null, manifest, { label: 'mtime baseline', expectedContent });
          verifyContentTransition(canonicalIndex.snapshot, baseline.snapshot);
          const mutation = captureMutationFiles(touchedTree, manifest, ['a.md']);
          const touchedManifest = applyDeterministicMutation(touchedTree, manifest, mutation, { append: null, mtimeMs });
          const touched = await openVerified(open, null, touchedManifest, { label: 'mtime-only update', expectedContent });
          verifyContentTransition(baseline.snapshot, touched.snapshot);
        } finally {
          safeRmSync(touchedTree, { recursive: true, force: true });
        }

        const appendedTree = ephemeralWorkTree(join(packageRoot, '.tmp', 'test'), `repeat-${store}-append-`, source);
        try {
          verifyFileManifest(appendedTree, manifest, 'append repetition input');
          const open = () => openTreeForStore(store, appendedTree);
          const baseline = await openVerified(open, null, manifest, { label: 'append baseline', expectedContent });
          verifyContentTransition(canonicalIndex.snapshot, baseline.snapshot);
          const mutation = captureMutationFiles(appendedTree, manifest, ['a.md']);
          const appendedManifest = applyDeterministicMutation(appendedTree, manifest, mutation, { append: ' benchmark-edit', mtimeMs });
          const appendedFile = appendedManifest.find((entry: { rel: string }) => entry.rel === 'a.md');
          const canonicalFile = manifest.find((entry: { rel: string }) => entry.rel === 'a.md');
          assert.ok(appendedFile && canonicalFile);
          assert.equal(appendedFile.bytes, canonicalFile.bytes + Buffer.byteLength(' benchmark-edit'));
          const appendedExpected = new Map(expectedContent);
          appendedExpected.set('a.md', { title: 'Alpha', summary: 'Short', text: 'Plain benchmark-edit body. benchmark-edit' });
          const appended = await openVerified(open, null, appendedManifest, { label: 'append update', expectedContent: appendedExpected });
          verifyContentTransition(baseline.snapshot, appended.snapshot, ['a.md']);
          assert.throws(() => verifyContentTransition(baseline.snapshot, baseline.snapshot, ['a.md']), /did not change/, 'a stale index must fail even when the canonical source already contains the marker');
          fileFingerprints.push(fileManifestFingerprint(appendedManifest));
          indexFingerprints.push(appended.snapshot.fingerprint);
        } finally {
          safeRmSync(appendedTree, { recursive: true, force: true });
        }
      }

      assert.equal(fileFingerprints[0], fileFingerprints[1], 'the append never grows cumulatively');
      assert.equal(indexFingerprints[0], indexFingerprints[1], 'the same mutation produces the same index state');
      verifyFileManifest(source, sourceManifest, 'source after repetitions');
      assert.equal(existsSync(join(source, '.sense')), false);
      assert.equal(existsSync(join(source, 'sense.config.json')), false);
    });
  });

  it('rejects a real index with the right content-row count but the wrong path', async () => {
    const tree = scratchDir('repeat-index-path');
    writeNote(tree, 'a.md', { frontmatter: { title: 'Alpha' }, body: 'Body.' });
    const manifest = captureFileManifest(tree);
    const opened = await openTreeForStore('sqlite', tree);
    try {
      await (await opened.store.prepare('UPDATE content SET "path" = ? WHERE "path" = ?')).run('wrong.md', 'a.md');
      const snapshot = await readIndexSnapshot(opened.store);
      assert.throws(() => verifyIndexSnapshot(snapshot, manifest), /content is missing path: a\.md/);
    } finally {
      await opened.store.close();
    }
  });

  it('rejects different post-update fingerprints for identical repetitions', () => {
    assert.throws(() => verifyRepeatFingerprint('first-state', 'different-state', 'append update'), /repetition fingerprint mismatch/);
    assert.equal(verifyRepeatFingerprint(null, 'first-state', 'append update'), 'first-state');
  });

  it('pages every real store past 128 rows without depending on SQL and JS Unicode sort agreement', async () => {
    const tree = scratchDir('repeat-pages');
    const expectedContent = new Map<string, { title: string; summary: string; text: string }>();
    for (let i = 0; i < 129; i++) {
      const rel = `${String(i).padStart(3, '0')}.md`;
      writeNote(tree, rel, { frontmatter: { title: `T${i}`, summary: `S${i}`, private: `P${i}` }, body: `Body ${i}.` });
      expectedContent.set(rel, { title: `T${i}`, summary: `S${i}`, text: `Body ${i}.` });
    }
    writeNote(tree, '😀.md', { frontmatter: { title: 'Astral', summary: 'Unicode', private: 'excluded' }, body: 'Astral body.' });
    writeNote(tree, '\uE000.md', { frontmatter: { title: 'Private', summary: 'Unicode', private: 'excluded' }, body: 'Private body.' });
    expectedContent.set('😀.md', { title: 'Astral', summary: 'Unicode', text: 'Astral body.' });
    expectedContent.set('\uE000.md', { title: 'Private', summary: 'Unicode', text: 'Private body.' });
    const manifest = captureFileManifest(tree);
    await forEachStore(async (store) => {
      const opened = await openTreeForStore(store, tree);
      try {
        const snapshot = await readIndexSnapshot(opened.store, { expectedContent });
        verifyIndexSnapshot(snapshot, manifest, `paged ${store} index`);
        assert.equal(snapshot.content.size, 131);
      } finally {
        await opened.store.close();
      }
    });
  });
});

describe('native watcher readiness observer', () => {
  const rowHash = (row: { title: string; summary: string; text: string }) =>
    createHash('sha256')
      .update(JSON.stringify([row.title, row.summary, row.text]))
      .digest('hex');

  it('reports an exact wrong-path same-count snapshot as stale', () => {
    const snapshot = { metadata: new Map([['wrong.md', { mtimeMs: 1, bytes: 2 }]]), content: new Map([['wrong.md', '0'.repeat(64)]]) };
    const manifest = [{ rel: 'a.md', mtimeMs: 1, bytes: 2, sha256: '1'.repeat(64) }];
    assert.match(indexSnapshotMismatch(snapshot, manifest) ?? '', /missing path: a\.md/);
  });

  it('reaps an actual native observer on its hard process timeout', async () => {
    const tree = scratchDir('observer-timeout-tree');
    const configPath = join(tree, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, store: 'sqlite', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeNote(tree, 'a.md', { body: 'Actual observer timeout.' });
    const manifest = captureFileManifest(tree);
    const opened = await openTreeForStore('sqlite', tree);
    await opened.store.close();
    await assert.rejects(runNativeObserverAttempt({ pkgRoot: packageRoot, store: 'sqlite', configPath, manifest, expectedContent: null }, 0), /timed out after 0ms; reaped/);
  });

  it('keeps the machine-derived attempt bound at the readiness-window edge', () => {
    assert.equal(nativeObserverAttemptBudgetMs(5_000, 87), 5_000);
    assert.equal(nativeObserverAttemptBudgetMs(5_000, 0), 0);
  });

  it('fails explicitly when a measured package has no internal native observer seam', async () => {
    const pkgRoot = scratchDir('observer-missing-seam-package');
    await assert.rejects(runNativeObserverAttempt({ pkgRoot, store: 'sqlite', configPath: join(pkgRoot, 'sense.config.json'), manifest: [], expectedContent: [] }, 1000), /could not import .*store\/sqlite\/open\.js/);
  });

  it('proves DuckDB lexical readiness with its native index and result paths', async function () {
    this.timeout(30_000);
    const tree = scratchDir('observer-duckdb-lexical');
    const configPath = join(tree, 'sense.config.json');
    writeFileSync(configPath, JSON.stringify({ version: 5, store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {} }));
    writeNote(tree, 'a.md', { body: 'needle alpha' });
    writeNote(tree, 'b.md', { body: 'needle beta' });
    const manifest = captureFileManifest(tree);
    const opened = await openTreeForStore('duckdb', tree);
    let paths: string[];
    try {
      const rows = await opened.store.lexical.query('needle', { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 });
      paths = rows.map(({ path }) => path);
    } finally {
      await opened.store.close();
    }
    const payload = { pkgRoot: packageRoot, store: 'duckdb' as const, configPath, manifest, lexical: { terms: 'needle', limit: 10, expected_paths: paths } };
    const observed = await runNativeObserverAttempt(payload, await nativeObserverDeadlineMs(packageRoot, tree));
    assert.deepEqual(observed.lexical, { state: 'ready', indexed_docs: 2, indexed_paths: ['a.md', 'b.md'], paths });
    await assert.rejects(runNativeObserverAttempt({ ...payload, lexical: { ...payload.lexical, expected_paths: ['wrong.md'] } }, 1000), /DuckDB lexical result omitted/);
  });

  it('uses each real built watcher as a wake-up and verifies authored native state', async function () {
    this.timeout(30_000);
    await forEachStore(async (store) => {
      const tree = scratchDir(`watcher-observer-${store}`);
      const configPath = join(tree, 'sense.config.json');
      writeFileSync(configPath, JSON.stringify({ version: 5, store, presets: { default: { include: ['**/*.md'] } }, queries: {} }));
      writeNote(tree, 'a.md', { frontmatter: { title: 'Baseline', summary: 'Readiness', private: 'excluded' }, body: 'Baseline body.' });
      const baselineManifest = captureFileManifest(tree);
      const opened = await openTreeForStore(store, tree);
      try {
        const authored = new Map([['a.md', { title: 'Baseline', summary: 'Readiness', text: 'Baseline body.' }]]);
        const snapshot = await readIndexSnapshot(opened.store, { expectedContent: authored });
        verifyIndexSnapshot(snapshot, baselineManifest, `${store} baseline`);
      } finally {
        await opened.store.close();
      }

      const deadlineMs = await nativeObserverDeadlineMs(packageRoot, tree);
      writeNote(tree, 'a.md', { frontmatter: { title: 'Before watcher', summary: 'Readiness', private: 'excluded' }, body: 'First mutation.' });
      const beforeManifest = captureFileManifest(tree);
      const beforeRow = { title: 'Before watcher', summary: 'Readiness', text: 'First mutation.' };
      const stale = await runNativeObserverAttempt({ pkgRoot: packageRoot, store, configPath, manifest: beforeManifest, expectedContent: [['a.md', rowHash(beforeRow)]] }, deadlineMs);
      assert.equal(stale.state, 'stale');

      const watcher = startMeasuredWatcher({ pkgRoot: packageRoot, configPath });
      try {
        const started = await watcher.waitFor('started', 0, deadlineMs);
        writeNote(tree, 'a.md', { frontmatter: { title: 'After watcher', summary: 'Readiness', private: 'excluded' }, body: 'Watcher mutation.' });
        const expectedManifest = captureFileManifest(tree);
        const expectedRow = { title: 'After watcher', summary: 'Readiness', text: 'Watcher mutation.' };
        await watcher.waitFor('reconciled', started.next, deadlineMs);
        const observed = await waitForNativeIndex({ pkgRoot: packageRoot, store, configPath, manifest: expectedManifest, expectedContent: [['a.md', rowHash(expectedRow)]], authoredContent: [['a.md', expectedRow]] }, deadlineMs);
        assert.equal(observed.state, 'ready');
        assert.equal(observed.paths, 1);
        watcher.assertRunning();
      } finally {
        await watcher.close(deadlineMs);
      }
    });
  });
});

describe('classify: reversed-run downgrade', () => {
  it('a reversed run whose delta reverses sign downgrades moved to noise', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 90 } });
    assert.equal(c.verdict, 'noise');
  });

  it('a reversed run whose delta lands inside band downgrades moved to noise', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 110 } });
    assert.equal(c.verdict, 'noise');
  });

  it('a reversed run that agrees (same sign, still beyond band) stays moved', () => {
    const c = classify(WALL_ROW, 100, 130, { reversed: { prior: 100, current: 135 } });
    assert.equal(c.verdict, 'moved');
  });
});

describe('classify: consistent-growth promotion', () => {
  const build = (ms: number) => ({ inproc: { cold_build_ms: ms } });

  it('beyond band at 2+ of hub/13k/26k in the same direction promotes to moved with a consistency reason', () => {
    const current = { hub: build(130), 'scale-13k': build(260), 'scale-26k': build(400) };
    const prior = { hub: build(100), 'scale-13k': build(200), 'scale-26k': build(400) };
    const out = classifyCrossGroup(current, prior);
    const hub = out.find((c) => c.context === 'hub' && c.key === 'inproc.cold_build_ms');
    assert.equal(hub?.verdict, 'moved');
    assert.match(hub?.reason ?? '', /consistent, grows with size/);
  });

  it('beyond band at only one size, with no agreement elsewhere, is moved without the consistency reason', () => {
    const current = { hub: build(130), 'scale-13k': build(205) };
    const prior = { hub: build(100), 'scale-13k': build(200) };
    const out = classifyCrossGroup(current, prior);
    const hub = out.find((c) => c.context === 'hub' && c.key === 'inproc.cold_build_ms');
    assert.equal(hub?.verdict, 'moved');
    assert.ok(!/consistent/.test(hub?.reason ?? ''));
  });
});

describe('classify: quality rules', () => {
  it('a lower quality metric falls', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.3, { retrievalOwed: true });
    assert.equal(c.verdict, 'fell');
  });

  it('a higher quality metric is flat, improved', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.4, { retrievalOwed: true });
    assert.equal(c.verdict, 'flat');
    assert.match(c.reason ?? '', /improved/);
  });

  it('an unchanged quality metric is flat with no reason', () => {
    const c = classify(QUALITY_ROW, 0.34, 0.34, { retrievalOwed: true });
    assert.equal(c.verdict, 'flat');
    assert.equal(c.reason, null);
  });

  it('any quality change when the diff owed neither fever nor a retrieval-touching gate is moved', () => {
    const risen = classify(QUALITY_ROW, 0.34, 0.4, { retrievalOwed: false });
    const fallen = classify(QUALITY_ROW, 0.34, 0.3, { retrievalOwed: false });
    assert.equal(risen.verdict, 'moved');
    assert.equal(fallen.verdict, 'moved');
  });

  it('classifyEval applies the fell rule per variant, from an eval.mjs-shaped JSON', () => {
    const evalJson = { variants: { semantic: { ndcg: 0.3, rr: 0.5, hit: 0.7 } } };
    const priorEval = { variants: { semantic: { ndcg: 0.34, rr: 0.5, hit: 0.7 } } };
    const out = classifyEval('eval-nfcorpus', evalJson, priorEval, true);
    const ndcg = out.find((c) => c.key === 'ndcg');
    assert.equal(ndcg?.verdict, 'fell');
  });
});

describe('classify: tokens', () => {
  it('any change to a tokens-kind row is a contract', () => {
    assert.equal(classify(TOKENS_ROW, 496, 497).verdict, 'contract');
  });

  it('an unchanged tokens-kind row is flat', () => {
    assert.equal(classify(TOKENS_ROW, 496, 496).verdict, 'flat');
  });
});

describe('classify: bulk_change_ms and bulk_watch_ms gate on their own band (PLAN.md 3.51)', () => {
  const bulkChange = ROW_BY_KEY.get('bulk_change_ms');
  const bulkWatch = ROW_BY_KEY.get('bulk_watch_ms');
  const unaccounted = ROW_BY_KEY.get('inproc.unaccounted_ms');

  it('bulk_change_ms doubled exceeds the measured band and BLOCKs', () => {
    assert.equal(classify(bulkChange, 500, 1000).verdict, 'moved');
  });

  it('bulk_watch_ms doubled exceeds the measured band and BLOCKs', () => {
    assert.equal(classify(bulkWatch, 500, 1000).verdict, 'moved');
  });

  it('bulk_change_ms within its measured band PASSes', () => {
    assert.equal(classify(bulkChange, 500, 800).verdict, 'flat');
  });

  it('inproc.unaccounted_ms doubled still PASSes: a derived residual, never gates', () => {
    assert.equal(classify(unaccounted, 500, 1000).verdict, 'flat');
  });
});

describe('classifyWatchSanity: bulk_watch_ms must read below bulk_change_ms on its own, not just against a prior (PLAN.md 3.63)', () => {
  it('a real ratio (watch well below change) is not classified', () => {
    assert.equal(classifyWatchSanity('hub', { bulk_change_ms: 378, bulk_watch_ms: 147 }), null);
  });

  it('the bogus signature -- watch equal to change -- fails with a named reason', () => {
    const c = classifyWatchSanity('battery-duckdb-hub', { bulk_change_ms: 1189, bulk_watch_ms: 1237 });
    assert.equal(c?.verdict, 'failed');
    assert.match(c?.reason ?? '', /battery-duckdb-hub/);
    assert.match(c?.reason ?? '', /bulk_change_ms/);
  });

  it('missing either row is not classified, not a failure', () => {
    assert.equal(classifyWatchSanity('hub', { bulk_change_ms: 378, bulk_watch_ms: null }), null);
    assert.equal(classifyWatchSanity('hub', {}), null);
  });

  it('watchSanityGroup rolls up a whole store/size group, keyed by id', () => {
    const out = watchSanityGroup({ 'battery-turso-hub': { bulk_change_ms: 526, bulk_watch_ms: 158 }, 'battery-turso-stress': { bulk_change_ms: 500, bulk_watch_ms: 500 } });
    assert.equal(out.length, 1);
    assert.equal(out[0].context, 'battery-turso-stress');
  });

  it('a fabricated sitting where bulk_watch_ms equals bulk_change_ms reports a warning without a BLOCK reason', async () => {
    const reportsDir = scratchDir('watch-sanity-reports');
    const sitting = scratchDir('watch-sanity-sitting');
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ bulk_change_ms: 400, bulk_watch_ms: 400, measure_version: MEASURE_VERSION }));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { stress: { id: 'stress', status: 'ok' } }, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    assert.ok(report.classifications.some((row) => row.id.endsWith('bulk_watch_ms-sanity') && classificationSeverity(row) === 'WARN'));
    assert.ok(!(report.verdict_reasons as string[]).some((r) => /400ms is 100\.0% of bulk_change_ms's 400ms/.test(r)));
  });
});

describe('classifyCompare: same-sitting compare.mjs JSON', () => {
  it('a forced token mismatch between baseline and local produces a contract classification', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { find_row_tokens: 71 },
        local: { find_row_tokens: 90 },
      },
    };
    const out = classifyCompare(compareJson, null);
    const row = out.find((c) => c.key === 'find_row_tokens');
    assert.equal(row?.verdict, 'contract');
    assert.match(row?.reason ?? '', /71 -> 90/);
  });
});

describe('release comparison workload identity', () => {
  const run = (input: string) => {
    const inputs = { fixture: input, row: 'map_ms' };
    return { map_ms: 10, workload_identity: { logical_inputs: { rows: { map_ms: { inputs, fingerprint: identityHash(inputs) } } } } };
  };

  it('compares only matching row identities and keeps mismatches explicitly uncompared', () => {
    const matching = classifyCompare({ versions: ['prior', 'local'], results: { prior: run('same'), local: run('same') } }, null, { requireIdentity: true });
    assert.equal(matching.find((row) => row.key === 'map_ms')?.verdict, 'flat');
    const mismatch = classifyCompare({ versions: ['prior', 'local'], results: { prior: run('old'), local: run('new') } }, null, { requireIdentity: true });
    const row = mismatch.find((item) => item.key === 'map_ms');
    assert.equal(row?.verdict, 'no-compatible-prior');
    assert.equal(row?.prior, null);
    assert.equal(aggregateVerdict(mismatch, []).verdict, 'PASS', 'an uncompared valid row is not a passing comparison and is nonblocking by policy');
  });

  it('blocks a current measurement whose workload identity is missing', () => {
    const classifications = classifyCompare({ versions: ['prior', 'local'], results: { prior: run('same'), local: { map_ms: 10 } } }, null, { requireIdentity: true });
    const row = classifications.find((item) => item.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.equal(row?.invalid, true);
    assert.equal(aggregateVerdict(classifications, []).verdict, 'BLOCK');
  });

  it('rejects mismatched reversed identities before they can change a verdict', () => {
    const forward = { versions: ['prior', 'local'], results: { prior: run('same'), local: { ...run('same'), map_ms: 20 } } };
    const reversed = { versions: ['prior', 'local'], results: { prior: run('same'), local: run('different') } };
    const row = classifyCompare(forward, reversed, { requireIdentity: true }).find((item) => item.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.match(row?.reason ?? '', /reversed workload identity/);
  });

  it('only requests a reversed run for a moved row with matching workload identities', () => {
    const matching = { versions: ['prior', 'local'], results: { prior: run('same'), local: { ...run('same'), map_ms: 30 } } };
    assert.equal(shouldRunReversedCompare(matching), true);
    const mismatched = { versions: ['prior', 'local'], results: { prior: run('old'), local: { ...run('new'), map_ms: 30 } } };
    assert.equal(shouldRunReversedCompare(mismatched), false);
  });

  it('does not use an incompatible scale delta as consistency evidence', () => {
    const current = { hub: { ...run('same'), map_ms: 20 }, large: { ...run('different'), map_ms: 20 }, missing: { map_ms: 20 } };
    const prior = { hub: run('same'), large: run('same'), missing: { map_ms: 10 } };
    const rows = classifyCrossGroup(current, prior, { requireIdentity: true });
    assert.equal(rows.find((row) => row.context === 'hub' && row.key === 'map_ms')?.verdict, 'moved');
    assert.equal(rows.find((row) => row.context === 'large' && row.key === 'map_ms')?.verdict, 'no-compatible-prior');
    assert.equal(rows.find((row) => row.context === 'missing' && row.key === 'map_ms')?.verdict, 'failed');
    assert.doesNotMatch(rows.find((row) => row.context === 'hub' && row.key === 'map_ms')?.reason ?? '', /consistent, grows with size/);
  });

  it('quality identity ignores private paths but changes with logical corpus, query, or model inputs', () => {
    const quality = (tree: string, logical: { corpus: string; query: string; model: string }) => {
      const inputs = { corpus: logical.corpus, operation: { query: logical.query, k: 10 }, requested: { variant: 'semantic', config: { signals: { vectors: 1 } }, model: { reuse_eligible: true, fingerprint: logical.model } } };
      return { variants: { semantic: { ndcg: 1, rr: 1, hit: 1, execution: { config: { baseDir: tree } }, workload_identity: { inputs, fingerprint: identityHash(inputs) } } } };
    };
    const same = { corpus: 'same', query: 'same', model: 'same' };
    const matching = classifyEval('eval', quality('/tmp/a', same), quality('/tmp/b', same), true, { requireIdentity: true });
    assert.ok(matching.every((row) => row.verdict === 'flat'));
    for (const changed of ['corpus', 'query', 'model']) {
      const compared = classifyEval('eval', quality('/tmp/a', same), quality('/tmp/b', { ...same, [changed]: 'changed' }), true, { requireIdentity: true });
      assert.ok(compared.every((row) => row.verdict === 'no-compatible-prior'));
    }
  });
});

describe('classifyCompare / classifyCrossGroup: a failed command blocks instead of passing silently', () => {
  it('a null current with an errors entry produces a failed classification, and aggregateVerdict blocks with it first', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { map_ms: 80 },
        local: { map_ms: null, errors: { map_ms: 'exit 1: boom' } },
      },
    };
    const out = classifyCompare(compareJson, null);
    const row = out.find((c) => c.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.match(row?.reason ?? '', /boom/);

    const { verdict, reasons } = aggregateVerdict(out, []);
    assert.equal(verdict, 'BLOCK');
    assert.equal(reasons[0], row?.reason);
  });

  it('a null current with no errors entry is skipped, unchanged behaviour', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { map_ms: 80 },
        local: { map_ms: null },
      },
    };
    const out = classifyCompare(compareJson, null);
    assert.equal(
      out.find((c) => c.key === 'map_ms'),
      undefined
    );
  });

  it('classifyCrossGroup: a null current with an errors entry on that step is failed', () => {
    const out = classifyCrossGroup({ stress: { map_ms: null, errors: { map_ms: 'exit 2: kaboom' } } }, { stress: { map_ms: 80 } });
    const row = out.find((c) => c.key === 'map_ms');
    assert.equal(row?.verdict, 'failed');
    assert.match(row?.reason ?? '', /kaboom/);
  });

  it('classifyCrossGroup: a null current with no errors entry is skipped', () => {
    const out = classifyCrossGroup({ stress: { map_ms: null } }, { stress: { map_ms: 80 } });
    assert.equal(
      out.find((c) => c.key === 'map_ms'),
      undefined
    );
  });

  it('a named error invalidates a numeric current value, including nested in-process errors', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: {
        '0.1.0': { map_ms: 80, inproc: { cold_build_ms: 100 } },
        local: { map_ms: 80, errors: { map_ms: { message: 'repetition 1 failed' } }, inproc: { cold_build_ms: 100, error: 'open failed' } },
      },
    };
    const out = classifyCompare(compareJson, null);
    const map = out.find((c) => c.key === 'map_ms');
    assert.ok(map && 'invalid' in map);
    assert.equal(map.invalid, true);
    assert.match(map.reason ?? '', /repetition 1 failed/);
    const coldBuild = out.find((c) => c.key === 'inproc.cold_build_ms');
    assert.ok(coldBuild && 'invalid' in coldBuild);
    assert.equal(coldBuild.invalid, true);
    assert.match(coldBuild.reason ?? '', /open failed/);
  });

  it('an invalid prior or reversed timing reading cannot become a normal delta', () => {
    const compareJson = {
      versions: ['0.1.0', 'local'],
      results: { '0.1.0': { map_ms: 80, errors: { map_ms: 'prior failed' } }, local: { map_ms: 81 } },
    };
    const prior = classifyCompare(compareJson, null).find((c) => c.key === 'map_ms');
    assert.ok(prior && 'invalid' in prior);
    assert.equal(prior.invalid, true);
    const reversed = { versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 80 }, local: { map_ms: 81, errors: { map_ms: 'reverse failed' } } } };
    const reverseLocal = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 80 }, local: { map_ms: 81 } } }, reversed).find((c) => c.key === 'map_ms');
    assert.ok(reverseLocal);
    assert.match(reverseLocal.reason ?? '', /reverse failed/);
    const reverseBaseline = { versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 80, errors: { map_ms: 'reverse baseline failed' } }, local: { map_ms: 81 } } };
    const reverseBaselineOut = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 80 }, local: { map_ms: 81 } } }, reverseBaseline);
    const reversePrior = reverseBaselineOut.find((c) => c.key === 'map_ms');
    assert.ok(reversePrior && 'invalid' in reversePrior);
    assert.equal(reversePrior.invalid, true);
    assert.equal(aggregateVerdict(reverseBaselineOut, []).verdict, 'BLOCK');
  });

  it('an empty or malformed compare artifact is invalid rather than an empty PASS', () => {
    const out = classifyCompare({ versions: [], results: {} }, null);
    const invalid = out[0];
    assert.ok('invalid' in invalid);
    assert.equal(invalid.invalid, true);
    assert.equal(aggregateVerdict(out, []).verdict, 'BLOCK');
  });

  it('a structurally valid compare with no current readings is invalid, including reversed output', () => {
    const empty = { versions: ['0.1.0', 'local'], results: { '0.1.0': {}, local: {} } };
    const out = classifyCompare(empty, null);
    assert.ok('invalid' in out[0]);
    assert.equal(aggregateVerdict(out, []).verdict, 'BLOCK');
    const reversedOut = classifyCompare({ versions: ['0.1.0', 'local'], results: { '0.1.0': { map_ms: 80 }, local: { map_ms: 81 } } }, empty);
    assert.ok('invalid' in reversedOut[0]);
    assert.equal(aggregateVerdict(reversedOut, []).verdict, 'BLOCK');
  });

  it('a present cross-group step with no readings is invalid rather than an empty PASS', () => {
    const out = classifyCrossGroup({ stress: {} }, { stress: { map_ms: 80 } });
    const invalid = out[0];
    assert.ok('invalid' in invalid);
    assert.equal(invalid.invalid, true);
    assert.equal(aggregateVerdict(out, []).verdict, 'BLOCK');
  });
});

describe('classifyEval: invalid quality artifacts block before metric comparison', () => {
  it('an all-error artifact with equal metrics produces one invalid classification and BLOCKs', () => {
    const evalJson = {
      variants: {
        semantic: {
          ndcg: 0,
          rr: 0,
          hit: 0,
          errors: 2,
          incomplete: true,
          error_details: [
            { qid: 'q1', error: 'query failed' },
            { qid: 'q2', error: 'query failed' },
          ],
        },
      },
    };
    const out = classifyEval('eval-nfcorpus', evalJson, { variants: { semantic: { ndcg: 0, rr: 0, hit: 0 } } }, true);
    assert.equal(out.filter((c) => 'variant' in c && c.variant === 'semantic').length, 1);
    const invalid = out[0];
    assert.ok('invalid' in invalid);
    assert.equal(invalid.invalid, true);
    assert.match(invalid.reason ?? '', /q1/);
    assert.equal(aggregateVerdict(out, []).verdict, 'BLOCK');
  });

  it('a non-finite prior quality metric is an explicit invalid baseline', () => {
    const out = classifyEval('eval-nfcorpus', { variants: { semantic: { ndcg: 0.2, rr: 0.3, hit: 0.4 } } }, { variants: { semantic: { ndcg: Number.NaN, rr: 0.3, hit: 0.4 } } }, true);
    const invalid = out[0];
    assert.ok('invalid' in invalid);
    assert.equal(invalid.invalid, true);
    assert.match(invalid.reason ?? '', /prior artifact is non-finite/);
    assert.equal(aggregateVerdict(out, []).verdict, 'BLOCK');
  });

  it('an incomplete present hidden variant cannot make the quality artifact look complete', () => {
    const out = classifyEval('eval-nfcorpus', { variants: { 'fused-embed-configured': { errors: 0, incomplete: true } } }, null, true);
    assert.equal(out.length, 1);
    const invalid = out[0];
    assert.ok('variant' in invalid);
    assert.equal(invalid.variant, 'fused-embed-configured');
    assert.ok('invalid' in invalid);
    assert.equal(invalid.invalid, true);
  });
});

describe('evaluateVariant: real retrieval failures stop quality work', () => {
  it('records the failing qid and does not issue later queries', async () => {
    const baseDir = scratchDir('quality-invalid-query');
    writeNote(baseDir, 'note.md', { body: 'retrieval fixture' });
    const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, store: 'sqlite' as const };
    const opened = await openConfig(cfg);
    const qrels = new Map([['q1', new Map([['note', 1]])]]);
    let calls = 0;
    let result: Awaited<ReturnType<typeof evaluateVariant>>;
    try {
      result = await evaluateVariant({
        qids: ['q1', 'q2'],
        queries: new Map([
          ['q1', 'valid'],
          ['q2', 'must-not-run'],
        ]),
        qrels,
        k: 1,
        search: (terms: SearchTerms, options: SearchOptions) => {
          calls++;
          return search(opened.store, cfg, terms, options);
        },
        queryFor: () => '(',
      });
    } finally {
      await opened.store.close();
    }
    assert.equal(calls, 1);
    assert.equal(result.incomplete, true);
    assert.equal(result.errorDetails.length, 1);
    assert.equal(result.errorDetails[0].qid, 'q1');
    assert.match(result.errorDetails[0].error, /Error|error|SQL|FTS/);
  });

  it('keeps a legitimate empty ranking valid', async () => {
    const baseDir = scratchDir('quality-empty-result');
    writeNote(baseDir, 'note.md', { body: 'retrieval fixture' });
    const cfg = { presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, store: 'sqlite' as const };
    const opened = await openConfig(cfg);
    try {
      const result = await evaluateVariant({
        qids: ['q1'],
        queries: new Map([['q1', 'valid']]),
        qrels: new Map([['q1', new Map()]]),
        k: 1,
        search: (terms: SearchTerms, options: SearchOptions) => search(opened.store, cfg, terms, options),
        queryFor: () => 'term_that_is_not_in_the_note',
      });
      assert.equal(result.incomplete, false);
      assert.deepEqual(result.errorDetails, []);
      assert.equal(result.perQuery.size, 1);
    } finally {
      await opened.store.close();
    }
  });
});

describe('aggregateVerdict: validity cannot be accepted as performance', () => {
  it('an accepted total row with a null current and named error still BLOCKs', () => {
    const compare = { versions: ['0.1.0', 'local'], results: { '0.1.0': { setup_ms: 10 }, local: { setup_ms: null, errors: { setup_ms: 'timed repetition failed' } } } };
    const classification = classifyCompare(compare, null).find((c) => c.key === 'setup_ms');
    assert.equal(ROW_BY_KEY.get('setup_ms')?.kind, 'total');
    assert.ok(classification && 'invalid' in classification);
    assert.equal(classification.invalid, true);
    const result = aggregateVerdict([classification], [], { [classification.id]: { reason: 'owner accepted the old performance delta' } });
    assert.equal(result.verdict, 'BLOCK');
    assert.deepEqual(result.reasons, [classification.reason]);
  });
});

describe('store-dump evidence is recomputed from retained captures', () => {
  const stores = ['sqlite', 'duckdb', 'turso'];
  const capture = (root: string, changed = false) => {
    for (const store of stores) {
      const dir = join(root, store);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'tables.txt'), `== sections (2 rows) ==\n{"path":"same.md","idx":0,"heading":"${changed ? 'changed' : 'first'}"}\n{"path":"same.md","idx":1,"heading":"second"}\n`);
      writeFileSync(join(dir, 'ranking.txt'), '== "query" (1 rows) ==\n{"path":"same.md","score":1}\n');
    }
  };
  const artifactFor = (sitting: string, changed = false) => {
    const before = join(sitting, 'store-dump-captures', 'before');
    const after = join(sitting, 'store-dump-captures', 'after');
    capture(before);
    capture(after, changed);
    const compared = compareCaptureDirectories(before, after);
    return {
      baseline: '9.9.9',
      ok: compared.ok,
      captures: { before: 'store-dump-captures/before', after: 'store-dump-captures/after' },
      capture_identity: { before: captureIdentity(before), after: captureIdentity(after) },
      stores: compared.stores,
      diff: compared.diff,
    };
  };
  const sittingJson = (steps: Record<string, unknown> = {}) => ({
    date: '2099-02-01',
    baseline_version: '9.9.9',
    last_tag: 'v9.9.8',
    machine: { cpu_model: 'Fixture' },
    node: 'v99',
    changed_paths: [],
    owed: { 'store-dump': ['fixture'] },
    steps: { validate: { id: 'validate', status: 'ok' }, 'npm-test': { id: 'npm-test', status: 'ok' }, 'store-dump': { id: 'store-dump', status: 'ok' }, ...steps },
    failed_stage_reasons: [],
  });

  it('retains an unparsable legacy row as hashed evidence instead of dropping it', () => {
    const [section] = structuredRows('== embeddings (1 rows) ==\n{"path":"a.md","vector":hex:00ff}\n');
    assert.equal(section.rows.length, 1);
    const row = section.rows[0] as { value: { raw: string }; sha256: string };
    assert.equal(row.value.raw, '{"path":"a.md","vector":hex:00ff}');
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
  });

  it('accepts a generated artifact and keeps duplicate path identities distinct', async () => {
    const sitting = scratchDir('store-dump-recomputed');
    const equalSitting = scratchDir('store-dump-recomputed-equal');
    const equalArtifact = artifactFor(equalSitting);
    writeFileSync(join(equalSitting, 'store-dump.json'), JSON.stringify(equalArtifact));
    writeFileSync(join(equalSitting, 'sitting.json'), JSON.stringify(sittingJson()));
    assert.equal(buildReport(equalSitting, { reportsDir: scratchDir('store-dump-recomputed-equal-reports') }).verdict, 'PASS');
    const artifact = artifactFor(sitting, true);
    assert.equal(artifact.ok, false);
    const changed = artifact.diff.changed_files[0].changed_entries;
    assert.deepEqual(
      changed.map((entry: { identity: string }) => entry.identity),
      ['["same.md",0]']
    );
    assert.ok((artifact.diff.categories as { value: Array<{ identity: string }> }).value.some((entry) => entry.identity === '["same.md",0]'));
    writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify(artifact));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson()));
    const report = buildReport(sitting, { reportsDir: scratchDir('store-dump-recomputed-reports') });
    assert.equal(report.verdict, 'BLOCK');
    assert.ok(report.classifications.some((classification) => classification.id === 'store-dump/validity' && 'invalid' in classification && classification.invalid === true));
  });

  it('blocks baseline, capture containment, and malformed category tampering', () => {
    const sitting = scratchDir('store-dump-tamper');
    const artifact = artifactFor(sitting);
    artifact.baseline = '9.9.8';
    writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify(artifact));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson()));
    let report = buildReport(sitting, { reportsDir: scratchDir('store-dump-tamper-baseline-reports') });
    assert.ok((report.verdict_reasons as string[]).some((reason) => /baseline .* does not match sitting baseline/.test(reason)));

    const outside = structuredClone(artifact);
    outside.baseline = '9.9.9';
    symlinkSync(join(sitting, 'store-dump-captures', 'before'), join(sitting, 'capture-link'), 'dir');
    outside.captures.before = 'capture-link';
    writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify(outside));
    report = buildReport(sitting, { reportsDir: scratchDir('store-dump-tamper-containment-reports') });
    assert.ok((report.verdict_reasons as string[]).some((reason) => /capture before is invalid/.test(reason)));

    const malformed = structuredClone(artifact);
    (malformed.stores as Record<string, { files: Record<string, { categories: { schema: unknown } }> }>).sqlite.files['tables.txt'].categories.schema = 'not-an-array';
    writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify(malformed));
    report = buildReport(sitting, { reportsDir: scratchDir('store-dump-tamper-category-reports') });
    assert.ok((report.verdict_reasons as string[]).some((reason) => /category schema is malformed/.test(reason)));
  });

  it('renders malformed saved store evidence as a nonwaivable validity block', () => {
    const malformedValues = [null, 'tables.txt', {}, 1];
    for (const malformedArtifacts of malformedValues) {
      const sitting = scratchDir('store-dump-malformed-artifacts');
      const artifact = artifactFor(sitting);
      ((artifact.stores as Record<string, { artifacts: unknown }>).sqlite as { artifacts: unknown }).artifacts = malformedArtifacts;
      writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify(artifact));
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson()));
      writeFileSync(join(sitting, 'release-gate.json'), JSON.stringify({ accepted: { 'store-dump/validity': { reason: 'fixture acceptance' } } }));
      const report = buildReport(sitting, { reportsDir: scratchDir('store-dump-malformed-artifacts-reports') });
      const markdown = renderMarkdown(report);
      assert.equal(report.verdict, 'BLOCK');
      assert.ok(report.verdict_reasons.some((reason: string) => reason.includes('store-dump: sqlite comparison has malformed per-store evidence')));
      assert.match(markdown, /store-dump: sqlite comparison has malformed per-store evidence/);
      assert.ok(report.classifications.some((classification) => classification.id === 'store-dump/validity' && 'invalid' in classification && classification.invalid === true));
    }
  });

  it('renders null and primitive saved steps as named nonwaivable coverage blocks', () => {
    for (const malformedStep of [null, 'failed', 1, false]) {
      const sitting = scratchDir('malformed-saved-step');
      const json = sittingJson({ validate: malformedStep });
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(json));
      const report = buildReport(sitting, { reportsDir: scratchDir('malformed-saved-step-reports') });
      const markdown = renderMarkdown(report);
      assert.equal(report.verdict, 'BLOCK');
      assert.ok(report.verdict_reasons.some((reason: string) => reason === 'coverage: step "validate" has an invalid status'));
      assert.match(markdown, /coverage: step "validate" has an invalid status/);
      assert.ok(report.classifications.some((classification) => classification.id.startsWith('coverage/') && 'invalid' in classification && classification.invalid === true));
    }
  });

  it('renders malformed saved stage reasons as a named nonwaivable coverage block', () => {
    for (const malformedReasons of [{}, 'validate: failed', 1, false]) {
      const sitting = scratchDir('malformed-saved-stage-reasons');
      const json = { ...sittingJson(), failed_stage_reasons: malformedReasons };
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(json));
      const report = buildReport(sitting, { reportsDir: scratchDir('malformed-saved-stage-reasons-reports') });
      assert.equal(report.verdict, 'BLOCK');
      assert.ok(report.verdict_reasons.some((reason: string) => reason === 'coverage: recorded failed_stage_reasons is not an array'));
      assert.match(renderMarkdown(report), /coverage: recorded failed_stage_reasons is not an array/);
    }
  });
});

describe('oracle artifacts are strict and self-consistent', () => {
  const extentKeys = ['frontmatterSections', 'eofPhantom', 'blockRefAnchor', 'commentSwallow', 'commentCascade', 'listContinuation', 'sectionMerge', 'edgeAdjust', 'trailingBlank', 'malformedFrontmatter', 'unexplained'];
  const oracle = () => ({ vault: 'fixture-vault', filesCompared: 1, tags: { differing: 0 }, links: { differing: 0 }, deadLinks: { differing: 0 }, headings: { differing: 0 }, blockExtents: Object.fromEntries(extentKeys.map((key) => [key, 0])), parity: true });
  const sitting = (artifact: Record<string, unknown>) => {
    const dir = scratchDir('oracle-strict');
    writeFileSync(join(dir, 'oracle.json'), JSON.stringify(artifact));
    writeFileSync(
      join(dir, 'sitting.json'),
      JSON.stringify({
        date: '2099-02-01',
        baseline_version: '9.9.9',
        last_tag: 'v9.9.8',
        machine: { cpu_model: 'Fixture' },
        node: 'v99',
        changed_paths: [],
        owed: { oracle: ['fixture'] },
        steps: { validate: { id: 'validate', status: 'ok' }, 'npm-test': { id: 'npm-test', status: 'ok' }, oracle: { id: 'oracle', status: 'ok' } },
        failed_stage_reasons: [],
      })
    );
    return dir;
  };

  it('accepts positive finite coverage and rejects missing, extra, and contradictory fields', () => {
    const cases: Array<{ mutate: (artifact: ReturnType<typeof oracle>) => void; text: RegExp }> = [
      { mutate: (artifact) => (artifact.filesCompared = 0), text: /filesCompared must be a positive integer/ },
      { mutate: (artifact) => (artifact.blockExtents.extra = 0), text: /blockExtents keys must be exactly/ },
      { mutate: (artifact) => (artifact.blockExtents.unexplained = -1), text: /blockExtents.unexplained must be a nonnegative integer/ },
      { mutate: (artifact) => (artifact.tags.differing = 1), text: /parity does not match differing\/unexplained/ },
    ];
    const validReport = buildReport(sitting(oracle()), { reportsDir: scratchDir('oracle-strict-valid-reports') });
    assert.equal(validReport.verdict, 'PASS');
    for (const [index, testCase] of cases.entries()) {
      const artifact = oracle();
      testCase.mutate(artifact);
      const report = buildReport(sitting(artifact), { reportsDir: scratchDir(`oracle-strict-invalid-${index}-reports`) });
      assert.equal(report.verdict, 'BLOCK');
      assert.ok(
        (report.verdict_reasons as string[]).some((reason) => testCase.text.test(reason)),
        JSON.stringify(report.verdict_reasons)
      );
    }
  });
});

describe('classification acceptance fingerprints retain the actual quality artifact', () => {
  it('maps eval and portable contexts to their artifact and becomes stale after tampering', () => {
    const sitting = scratchDir('acceptance-quality-evidence');
    const artifacts = {
      'eval-nfcorpus.json': { corpus: 'nfcorpus', marker: 'eval' },
      'portable-eval-nfcorpus-sqlite.json': { corpus: 'nfcorpus', marker: 'portable' },
    };
    for (const [name, artifact] of Object.entries(artifacts)) writeFileSync(join(sitting, name), JSON.stringify(artifact));
    const report = { measure_version: MEASURE_VERSION, classifications: [] };
    const evalClassification = { id: 'eval-nfcorpus/semantic/ndcg', context: 'eval-nfcorpus/semantic', verdict: 'fell', prior: 0.5, current: 0.4, workload_id: 'eval' };
    const portableClassification = { id: 'portable-eval-nfcorpus-sqlite/semantic/ndcg', context: 'portable-eval-nfcorpus-sqlite/semantic', verdict: 'fell', prior: 0.5, current: 0.4, workload_id: 'portable' };
    const evalEvidence = classificationEvidence(sitting, 'eval-nfcorpus/semantic/ndcg', evalClassification);
    const portableEvidence = classificationEvidence(sitting, 'portable-eval-nfcorpus-sqlite/semantic/ndcg', portableClassification);
    assert.equal(evalEvidence[0].id, 'eval-nfcorpus');
    assert.equal(portableEvidence[0].id, 'portable-eval-nfcorpus-sqlite');
    const evalReport = { ...report, classifications: [evalClassification] };
    const before = acceptanceFingerprint('eval-nfcorpus/semantic/ndcg', evalReport, sitting);
    writeFileSync(join(sitting, 'eval-nfcorpus.json'), JSON.stringify({ ...artifacts['eval-nfcorpus.json'], marker: 'tampered' }));
    const after = acceptanceFingerprint('eval-nfcorpus/semantic/ndcg', evalReport, sitting);
    assert.notEqual(before, after);
  });
});

describe('buildReport: present current artifacts must carry the current harness stamp', () => {
  const metricRow = (n: number, measureVersion = MEASURE_VERSION) =>
    identifiedRun({
      map_ms: n,
      measure_version: measureVersion,
    });

  const sittingJson = { date: '2099-02-01', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { validate: { id: 'validate', status: 'ok' }, 'npm-test': { id: 'npm-test', status: 'ok' } }, failed_stage_reasons: [] };
  const writeSitting = (step: unknown, compare = true) => {
    const sitting = scratchDir('current-artifact-sitting');
    const id = compare ? 'compare' : 'stress';
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ ...sittingJson, owed: compare ? { baseline: ['fixture'] } : {}, steps: { ...sittingJson.steps, [id]: { id, status: 'ok' } } }));
    writeFileSync(join(sitting, compare ? 'compare.json' : 'stress.json'), JSON.stringify(step));
    return sitting;
  };
  const compareArtifact = (wrapperVersion = MEASURE_VERSION, innerVersion = MEASURE_VERSION) => ({
    versions: ['0.1.0', 'local'],
    measure_version: wrapperVersion,
    results: { '0.1.0': metricRow(100, innerVersion), local: metricRow(100, innerVersion) },
  });

  it('keeps a valid current compare wrapper numeric while incomplete baseline coverage still blocks the synthetic fixture', async () => {
    const sitting = writeSitting(compareArtifact());
    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir: scratchDir('current-artifact-reports') });
    assert.equal(report.verdict, 'BLOCK');
    assert.ok(report.classifications.length > 0);
    assert.ok(!report.classifications.some((row) => row.id === 'compare/validity'));
  });

  it('blocks stale or missing current stamps on plain and compare artifacts', async () => {
    const staleVersion = 'fixture-old';
    const cases = [
      { name: 'plain-stale', artifact: metricRow(100, staleVersion), compare: false, text: new RegExp(`stress: current artifact measure_version ${staleVersion} does not match current ${MEASURE_VERSION}`) },
      { name: 'plain-missing', artifact: { ...metricRow(100), measure_version: undefined }, compare: false, text: /stress: current artifact has no measure_version stamp/ },
      { name: 'wrapper-stale', artifact: compareArtifact(staleVersion), compare: true, text: new RegExp(`compare: current artifact measure_version ${staleVersion} does not match current ${MEASURE_VERSION}`) },
      { name: 'wrapper-missing', artifact: { ...compareArtifact(), measure_version: undefined }, compare: true, text: /compare: current artifact has no measure_version stamp/ },
      { name: 'inner-stale', artifact: compareArtifact(MEASURE_VERSION, staleVersion), compare: true, text: new RegExp(`compare: inner result .* measure_version ${staleVersion} does not match current ${MEASURE_VERSION}`) },
    ];
    const { buildReport } = await import('../../benchmark/report.mjs');
    for (const testCase of cases) {
      const sitting = writeSitting(testCase.artifact, testCase.compare);
      const report = buildReport(sitting, { reportsDir: scratchDir(`${testCase.name}-reports`) });
      assert.equal(report.verdict, 'BLOCK', testCase.name);
      assert.ok(
        (report.verdict_reasons as string[]).some((reason) => testCase.text.test(reason)),
        `${testCase.name}: ${JSON.stringify(report.verdict_reasons)}`
      );
    }
  });

  it('blocks a missing current inner stamp, present null/shape artifacts, reverse artifacts, and quality stamps', async () => {
    const { buildReport } = await import('../../benchmark/report.mjs');
    const complete = compareArtifact();
    const missingInner = { ...complete, results: { ...complete.results, local: { map_ms: 100 } } };
    const cases: Array<{ name: string; files: Record<string, unknown>; text: RegExp }> = [
      { name: 'inner-missing', files: { 'compare.json': missingInner }, text: /compare: inner result local has no measure_version stamp/ },
      { name: 'present-null', files: { 'stress.json': null }, text: /stress: current artifact JSON is not an object/ },
      { name: 'malformed-shape', files: { 'compare.json': { measure_version: MEASURE_VERSION } }, text: /compare: compare artifact is incomplete/ },
      { name: 'reverse-stale', files: { 'compare.json': compareArtifact(), 'compare-reversed.json': compareArtifact('fixture-old') }, text: /compare-reversed: current artifact measure_version fixture-old does not match current/ },
      { name: 'quality-stale', files: { 'eval-nfcorpus.json': { variants: {}, measure_version: 'fixture-old' } }, text: /eval-nfcorpus: current artifact measure_version fixture-old does not match current/ },
    ];
    for (const testCase of cases) {
      const sitting = scratchDir(`current-${testCase.name}`);
      const steps = Object.fromEntries(
        Object.keys(testCase.files).map((name) => {
          const id = name.slice(0, -'.json'.length);
          return [id, { id, status: 'ok' }];
        })
      );
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ ...sittingJson, steps: { ...sittingJson.steps, ...steps } }));
      for (const [name, artifact] of Object.entries(testCase.files)) writeFileSync(join(sitting, name), JSON.stringify(artifact));
      const report = buildReport(sitting, { reportsDir: scratchDir(`${testCase.name}-reports`) });
      assert.equal(report.verdict, 'BLOCK', testCase.name);
      assert.ok(
        (report.verdict_reasons as string[]).some((reason) => testCase.text.test(reason)),
        `${testCase.name}: ${JSON.stringify(report.verdict_reasons)}`
      );
    }
  });

  it('requires the conditional reversed step when a compare row moved beyond its band', async () => {
    const artifact = compareArtifact();
    artifact.results.local.map_ms = 200;
    const sitting = writeSitting(artifact);
    const report = buildReport(sitting, { reportsDir: scratchDir('missing-required-reverse-reports') });
    assert.equal(report.verdict, 'BLOCK');
    assert.ok(
      (report.verdict_reasons as string[]).some((reason) => reason === 'coverage: compare-reversed is required by a moved compare row but has no recorded status'),
      JSON.stringify(report.verdict_reasons)
    );
  });

  it('reports malformed present compare JSON without throwing, and acceptance cannot waive it', async () => {
    const sitting = scratchDir('malformed-current-compare');
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify(sittingJson));
    writeFileSync(join(sitting, 'compare.json'), '{not json');
    writeFileSync(join(sitting, 'release-gate.json'), JSON.stringify({ accepted: { 'compare/validity': { reason: 'old performance decision' } } }));
    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir: scratchDir('malformed-current-compare-reports') });
    assert.equal(report.verdict, 'BLOCK');
    assert.ok(
      (report.verdict_reasons as string[]).some((reason) => /compare: current artifact JSON is malformed/.test(reason)),
      JSON.stringify(report.verdict_reasons)
    );
  });

  it('blocks a missing artifact from every recorded successful out step, even when accepted', () => {
    const outIds = new Set<string>();
    for (const stage of buildStages()) {
      for (const step of stage.steps) {
        if ('out' in step && step.out) outIds.add(step.id);
      }
    }
    for (const id of outIds) {
      const sitting = scratchDir(`missing-successful-${id}`);
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ ...sittingJson, steps: { [id]: { id, status: 'ok' } } }));
      writeFileSync(join(sitting, 'release-gate.json'), JSON.stringify({ accepted: { [`${id}/validity`]: { reason: 'old performance decision' } } }));
      const report = buildReport(sitting, { reportsDir: scratchDir(`missing-successful-${id}-reports`) });
      assert.equal(report.verdict, 'BLOCK', id);
      assert.ok(
        report.classifications.some((classification) => classification.id === `${id}/validity` && 'invalid' in classification && classification.invalid === true),
        id
      );
      assert.ok(
        (report.verdict_reasons as string[]).some((reason) => reason === `${id}: recorded successful step has no current artifact`),
        id
      );
      assert.equal((report.steps as Record<string, { error?: string }>)[id]?.error, `${id}: recorded successful step has no current artifact`);
    }
    for (const id of ['compare', 'eval-nfcorpus', 'battery-duckdb-hub', 'store-dump', 'oracle']) {
      assert.ok(outIds.has(id), `${id} must remain an out:true stage step`);
    }

    for (const id of ['store-dump', 'oracle']) {
      const sitting = scratchDir(`present-unstamped-${id}`);
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ ...sittingJson, steps: { ...sittingJson.steps, [id]: { id, status: 'ok' } } }));
      writeFileSync(join(sitting, `${id}.json`), JSON.stringify({ ok: true, output: 'fixture' }));
      const report = buildReport(sitting, { reportsDir: scratchDir(`present-unstamped-${id}-reports`) });
      assert.equal(report.verdict, 'BLOCK', id);
      assert.ok(
        report.classifications.some((classification) => classification.id === `${id}/validity` && 'invalid' in classification && classification.invalid === true),
        id
      );
    }
  });

  it('does not turn non-output, not-run, or owed-unmet steps into missing-artifact validity rows', () => {
    const cases = [
      { name: 'non-output-ok', id: 'validate', status: 'ok', verdict: 'PASS', reason: null },
      { name: 'not-run', id: 'compare', status: 'not-run', verdict: 'BLOCK', reason: 'compare: not run' },
      { name: 'not-owed', id: 'oracle', status: 'not-owed', verdict: 'PASS', reason: null },
      { name: 'owed-unmet', id: 'oracle', status: 'owed-unmet', verdict: 'PASS', reason: null },
      { name: 'owed-unmet-without-declaration', id: 'validate', status: 'owed-unmet', verdict: 'BLOCK', reason: 'without an explicit unavailable exit' },
    ] as const;
    for (const testCase of cases) {
      const sitting = scratchDir(`missing-policy-${testCase.name}`);
      const owed = testCase.status === 'owed-unmet' ? { oracle: ['fixture'] } : {};
      writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ ...sittingJson, owed, steps: { ...sittingJson.steps, [testCase.id]: { id: testCase.id, status: testCase.status } } }));
      const report = buildReport(sitting, { reportsDir: scratchDir(`missing-policy-${testCase.name}-reports`) });
      assert.equal(report.verdict, testCase.verdict, testCase.name);
      assert.ok(!report.classifications.some((classification) => classification.id === `${testCase.id}/validity`), testCase.name);
      if (testCase.reason)
        assert.ok(
          (report.verdict_reasons as string[]).some((reason) => reason.includes(testCase.reason)),
          testCase.name
        );
    }
  });
});

describe('owedReasons: a tree with no diff since its tag owes everything', () => {
  it('only classifies an explicitly declared unavailable exit as owed-unmet', () => {
    assert.equal(stepStatus({ unavailableExit: 78 }, { code: 78, status: 'failed' }), 'owed-unmet');
    assert.equal(stepStatus({}, { code: 78, status: 'failed' }), 'failed');
    assert.equal(stepStatus({ unavailableExit: 78 }, { code: 1, status: 'failed' }), 'failed');
  });

  it('an empty diff owes every gate, explained by the tag it is at', () => {
    const reasons = owedReasons([], 'v9.9.8');
    assert.deepEqual([...reasons.keys()].sort(), [...GATE_NAMES].sort());
    for (const matched of reasons.values()) assert.deepEqual(matched, ['no diff since v9.9.8: this tree is the release']);
  });

  it('a real diff is unchanged: only the gates it matches are owed', () => {
    assert.deepEqual([...owedReasons(['README.md'], 'v9.9.8').keys()], []);
    const srcOnly = owedReasons(['src/store/sqlite/connection.ts'], 'v9.9.8');
    assert.ok(srcOnly.has('test-engines'));
    assert.ok(!srcOnly.has('fever'));
  });
});

describe('verbsFrom: a verb the CLI lacks reads as unmeasured, not a failure', () => {
  const HELP = execFileSync(process.execPath, [join(packageRoot, 'bin', 'cli.js'), '--help'], { encoding: 'utf8' });

  it('the current --help text carries every verb measure-tree.mjs routes through it', () => {
    const verbs = verbsFrom(HELP);
    for (const v of ['map', 'peek', 'related', 'path', 'watch', 'sql', 'search']) assert.ok(verbs.has(v), `--help must list ${v}`);
  });

  it('a text with no "sense map" line does not carry map', () => {
    const withoutMap = HELP.split('\n')
      .filter((line) => !/\bmap\b/.test(line))
      .join('\n');
    assert.ok(!verbsFrom(withoutMap).has('map'));
  });

  it('"sense <name>" and "sense --list"/"--version" are not verbs', () => {
    const verbs = verbsFrom(HELP);
    assert.ok(!verbs.has('<name>'));
    assert.ok(!verbs.has('--list'));
    assert.ok(!verbs.has('--version'));
  });
});

describe('diff map: every path exists in the tree', () => {
  it('every prefix or file the diff map names is a real path under this tree', () => {
    for (const p of DIFF_MAP_PATHS) {
      const full = join(packageRoot, p.endsWith('/') ? p.slice(0, -1) : p);
      assert.ok(existsSync(full), `benchmark/lib/gates.mjs names "${p}", which does not exist`);
    }
  });
});

describe('timeline-skips.json: a typo cannot silently skip nothing', () => {
  const { skips } = JSON.parse(readFileSync(join(packageRoot, 'benchmark', 'timeline-skips.json'), 'utf8'));
  const stores = JSON.parse(readFileSync(join(packageRoot, 'schema.json'), 'utf8')).properties.store.enum;
  const released = new Set([...readFileSync(join(packageRoot, 'CHANGELOG.md'), 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]));

  it('every entry names a released version and a store this tree offers', () => {
    for (const s of skips) {
      assert.ok(released.has(s.version), `timeline-skips.json names ${s.version}, which CHANGELOG.md does not release`);
      assert.ok(stores.includes(s.store), `timeline-skips.json names store ${s.store}, not one of ${stores.join(', ')}`);
    }
  });

  it('every entry says why it is skipped', () => {
    for (const s of skips) assert.ok(s.why?.trim(), `${s.version}/${s.store} is skipped with no reason`);
  });
});

describe('catalog / run.mjs key agreement', () => {
  it('a run.mjs row on the 20-note synthetic corpus has exactly the catalog wall/inproc/tokens keys', function () {
    this.timeout(120_000);
    const corpus = join(packageRoot, '.tmp', 'cache', 'synthetic-n20-t500-h8-l5-f30-fpn8-s1-c63b9320');
    gate(this, 'benchmark-corpus', existsSync(corpus), `${corpus} is not built; run a benchmark once on this machine to cache it`);
    const outPath = join(packageRoot, '.tmp', 'test', `harness-run-${Date.now()}.json`);
    execFileSync(process.execPath, [join(packageRoot, 'benchmark', 'steps', 'measure-tree.mjs'), packageRoot, corpus, '--out', outPath], { cwd: packageRoot, encoding: 'utf8' });
    const row = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(row.measure_version, MEASURE_VERSION);
    assert.equal(row.inproc.error, undefined);
    assert.equal(row.errors.bulk_change_ms, undefined);
    assert.equal(row.errors.bulk_watch_ms, undefined);
    assert.equal(typeof row.bulk_change_ms, 'number');
    assert.equal(typeof row.bulk_watch_ms, 'number');
    assert.equal(row.bulk_state.change.verified, true);
    assert.equal(row.bulk_state.watch.verified, true);
    assert.equal(row.bulk_state.change.preparation.length, 3);
    assert.equal(row.bulk_state.watch.preparation.length, 3);
    assert.deepEqual(Object.keys(row.inproc.repeat_state).sort(), ['canonical', 'cold_build', 'open_nochange', 'source', 'update_10_files', 'update_1_file']);
    assert.match(row.inproc.repeat_state.source.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(row.inproc.repeat_state.canonical.fingerprint, /^[0-9a-f]{64}$/);
    assert.match(row.inproc.repeat_state.canonical.indexed_content_fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(row.inproc.repeat_state.open_nochange.indexed_content_fingerprint, row.inproc.repeat_state.canonical.indexed_content_fingerprint);
    assert.equal(row.inproc.repeat_state.update_10_files.append, ' benchmark-edit');
    assert.equal(row.inproc.repeat_state.update_1_file.mutation_mtime_ms, row.inproc.repeat_state.update_10_files.mutation_mtime_ms);
    assert.equal(row.inproc.repeat_state.open_nochange.baseline, 'fresh copy + unmeasured canonical open');
    assert.equal(row.inproc.repeat_state.cold_build.baseline, 'fresh copy with no index');
    assert.equal(row.inproc.repeat_state.open_nochange.preparation.copy_ms.length, 5);
    assert.equal(row.inproc.repeat_state.open_nochange.preparation.baseline_open_ms.length, 5);
    assert.equal(row.inproc.repeat_state.update_1_file.preparation.copy_ms.length, 3);
    assert.equal(row.inproc.repeat_state.update_1_file.preparation.baseline_open_ms.length, 3);
    assert.equal(row.inproc.repeat_state.update_10_files.preparation.copy_ms.length, 3);
    assert.equal(row.inproc.repeat_state.update_10_files.preparation.baseline_open_ms.length, 3);
    assert.equal(row.inproc.repeat_state.cold_build.preparation.copy_ms.length, 3);
    assert.match(row.inproc.repeat_state.update_1_file.indexed_content_fingerprint, /^[0-9a-f]{64}$/);
    assert.match(row.inproc.repeat_state.update_10_files.indexed_content_fingerprint, /^[0-9a-f]{64}$/);
    const workloadRows = row.workload_identity.logical_inputs.rows;
    for (const key of ['version_canary_ms', 'cold_crawl_ms', 'warm_query_ms', 'find_ms', 'words_ms', 'cold_embed_ms', 'semantic_find_ms', 'map_ms', 'peek_ms', 'path_ms', 'related_ms']) {
      if (rowValue(row, key) === null) continue;
      const output = workloadRows[key].execution.timed_output;
      assert.equal(output.status, 'recorded', `${key}: timed output status`);
      assert.equal(output.workload_fingerprint, workloadRows[key].fingerprint, `${key}: workload link`);
      assert.deepEqual(
        output.repetitions.map((repetition: { attempt: number }) => repetition.attempt),
        Array.from({ length: output.repetitions.length }, (_, index) => index + 1),
        `${key}: unique attempt indexes`
      );
      for (const repetition of output.repetitions) {
        assert.equal(repetition.status, 0, `${key}: repetition status`);
        assert.ok(Number.isFinite(repetition.elapsed_ms) && repetition.elapsed_ms >= 0, `${key}: elapsed timing`);
        assert.match(repetition.stdout_sha256, /^[0-9a-f]{64}$/, `${key}: stdout digest`);
        assert.equal(repetition.stdout_utf16_code_units, repetition.bytes, `${key}: legacy byte field link`);
        assert.equal(typeof repetition.stdout_utf8_bytes, 'number', `${key}: UTF-8 size`);
      }
    }
    assert.equal(typeof workloadRows.cold_crawl_ms.execution.timed_output.phase.label, 'string');
    assert.equal(workloadRows.find_ms.execution.timed_output.process_scope, 'fresh CLI process per attempt');
    assert.equal(workloadRows.find_ms.execution.timed_output.phase.readiness, 'verified');
    assert.equal(workloadRows.find_ms.execution.lexical_readiness.status, 'verified');
    assert.deepEqual(
      workloadRows.peek_ms.execution.timed_output.phase.prior_rows.map((prior: { row: string }) => prior.row),
      ['map_ms']
    );
    assert.deepEqual(
      workloadRows.peek_ms.execution.timed_output.phase.intervening_rows.map((row: { row: string }) => row.row),
      ['find_row_tokens']
    );
    assert.equal(workloadRows.peek_ms.execution.timed_output.phase.intervening_rows[0].command_status, 'success');
    assert.equal(workloadRows.peek_ms.execution.timed_output.phase.intervening_rows[0].output_contract_status, 'recorded');
    assert.equal(workloadRows.peek_ms.execution.timed_output.phase.intervening_rows[0].command_status_code, 0);
    assert.deepEqual(
      workloadRows.related_ms.execution.timed_output.phase.prior_rows.map((prior: { row: string }) => prior.row),
      ['peek_ms']
    );
    assert.deepEqual(
      workloadRows.path_ms.execution.timed_output.phase.prior_rows.map((prior: { row: string }) => prior.row),
      ['related_ms']
    );
    assert.deepEqual(
      workloadRows.find_ms.execution.timed_output.repetitions.map((repetition: { phase: string }) => repetition.phase),
      ['first-lexical-after-count', 'later-lexical-after-count', 'later-lexical-after-count']
    );
    assert.deepEqual(
      workloadRows.semantic_find_ms.execution.timed_output.repetitions.map((repetition: { phase: string }) => repetition.phase),
      ['first-vector-after-cold-vector', 'later-vector-after-cold-vector', 'later-vector-after-cold-vector']
    );
    assert.equal(workloadRows.version_canary_ms.execution.timed_output.observed_format, 'text');
    assert.equal(workloadRows.find_ms.execution.timed_output.semantic_structure, 'unavailable-for-table');
    for (const key of ['bulk_change_ms', 'bulk_watch_ms']) {
      const output = workloadRows[key].execution.timed_output;
      assert.equal(output.observed_format, 'json');
      assert.deepEqual(
        output.repetitions.map((repetition: { attempt: number }) => repetition.attempt),
        [1, 2, 3]
      );
      assert.ok(output.repetitions.every((repetition: { decoded?: { count: number } }) => repetition.decoded?.count === row.notes));
    }
    const findContract = workloadRows.find_row_tokens.execution.output_contract;
    assert.equal(findContract.status, 'recorded');
    assert.equal(findContract.workload_fingerprint, workloadRows.find_row_tokens.fingerprint);
    assert.ok(findContract.paths.length > 0);
    assert.equal(new Set(findContract.paths).size, findContract.paths.length);
    assert.equal(findContract.paths.length, findContract.via.length);
    assert.equal(findContract.paths.length, findContract.snippet_sha256.length);
    for (const [key, source] of [
      ['map_tokens', 'map_ms'],
      ['peek_tokens', 'peek_ms'],
      ['related_tokens', 'related_ms'],
    ]) {
      const contract = workloadRows[key].execution.output_contract;
      assert.equal(contract.source_row, source);
      assert.equal(contract.source_stdout_sha256, workloadRows[source].execution.timed_output.repetitions.at(-1).stdout_sha256);
    }
    for (const key of ['inproc.cold_build_ms', 'inproc.open_nochange_ms', 'inproc.update_1_file_ms', 'inproc.update_10_files_ms']) assert.equal(workloadRows[key].execution.timed_output.status, 'not-cli');
    const topLevelMetricKeys = Object.keys(row).filter((k) => !RUN_META_KEYS.includes(k));
    const inprocMetricKeys = Object.keys(row.inproc).filter((k) => !INPROC_META_KEYS.includes(k));
    const flattened = [...topLevelMetricKeys, ...inprocMetricKeys.map((k) => `inproc.${k}`)].sort();
    assert.deepEqual(flattened, [...RUN_METRIC_KEYS].sort());
    // rowValue reaches every one of them, dotted paths included.
    for (const key of RUN_METRIC_KEYS) assert.notEqual(rowValue(row, key), undefined, `rowValue could not reach ${key}`);
    // open() returns stages on every reconcile, not only the cold build: both update reps must carry theirs.
    assert.ok(row.inproc.update_1_file_stages?.spans, 'update_1_file_ms must carry stages');
    assert.ok(row.inproc.update_10_files_stages?.spans, 'update_10_files_ms must carry stages');
  });
});

describe('prior resolution: per step, never per report', () => {
  // The defect this guards: one prior report for the whole run means a sitting that did not run a
  // step blinds the next sitting that does, and every row of that step reads no-prior, which passes.
  const metricRow = (n: number) =>
    identifiedRun({
      cold_crawl_ms: n,
      version_canary_ms: 20,
      warm_query_ms: 50,
      find_ms: 60,
      find_row_tokens: 71,
      cold_embed_ms: 200,
      semantic_find_ms: 70,
      map_ms: 80,
      map_tokens: 496,
      peek_ms: 90,
      peek_tokens: 581,
      related_ms: 100,
      related_tokens: 50,
      largest_note_tokens: 1000,
      bulk_change_ms: 500,
      bulk_watch_ms: 150,
      inproc: { cold_build_ms: n * 2, open_nochange_ms: 35, update_1_file_ms: 40, update_10_files_ms: 45 },
    });

  it('a step finds its prior in an older report when the newest report never ran it', async () => {
    const reportsDir = scratchDir('prior-per-step-reports');
    const sitting = scratchDir('prior-per-step-sitting');
    const stamp = (steps: Record<string, unknown>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...(v as object), measure_version: MEASURE_VERSION }]));
    const gateReport = (date: string, steps: Record<string, unknown>) => writeFileSync(join(reportsDir, `${date}-9.9.8-release-gate.json`), JSON.stringify({ date, verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: stamp(steps) }));
    gateReport('2099-01-01', { stress: metricRow(100) });
    gateReport('2099-01-02', {}); // a docs-only sitting: ran no measured step
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ ...metricRow(101), measure_version: MEASURE_VERSION }));
    writeFileSync(
      join(sitting, 'sitting.json'),
      JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: ['src/x.ts'], owed: { baseline: ['src/x.ts'] }, steps: { stress: { id: 'stress', status: 'ok' } }, failed_stage_reasons: [] })
    );

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(stress.length > 0, 'the stress step must produce classifications');
    assert.deepEqual(
      stress.filter((c: { verdict: string }) => c.verdict === 'no-prior').map((c: { key: string }) => c.key),
      [],
      'every stress row must find its prior in the older report, across the docs-only sitting between'
    );
    assert.equal((report.prior_from as Record<string, string>).stress, '2099-01-01-9.9.8-release-gate.json');
  });

  it('two releases on one day: the prior is the newest release at or below the baseline, never a later one', async () => {
    const reportsDir = scratchDir('prior-same-day-reports');
    const sitting = scratchDir('prior-same-day-sitting');
    const stamp = (steps: Record<string, unknown>) => Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { ...(v as object), measure_version: MEASURE_VERSION }]));
    const record = (version: string, value: number) => writeFileSync(join(reportsDir, `2099-01-01-${version}-release-gate.json`), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: stamp({ stress: metricRow(value) }) }));
    record('9.9.7', 90);
    record('9.9.8', 100);
    record('9.9.10', 200); // a later release than the baseline: a re-render after this sitting's own release must not read it
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ ...metricRow(101), measure_version: MEASURE_VERSION }));
    writeFileSync(
      join(sitting, 'sitting.json'),
      JSON.stringify({ date: '2099-01-01', baseline_version: '9.9.8', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: ['src/x.ts'], owed: { baseline: ['src/x.ts'] }, steps: { stress: { id: 'stress', status: 'ok' } }, failed_stage_reasons: [] })
    );

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    assert.equal((report.prior_from as Record<string, string>).stress, '2099-01-01-9.9.8-release-gate.json', 'same-day priors resolve by version, and 9.9.10 is not a prior of a 9.9.8 baseline');
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.equal(stress.filter((c: { verdict: string }) => c.verdict === 'no-prior').length, 0, 'every stress row found its prior on the same day');
  });

  it('a step no earlier report ever ran is a real no-prior', async () => {
    const reportsDir = scratchDir('prior-none-reports');
    const sitting = scratchDir('prior-none-sitting');
    writeFileSync(join(reportsDir, '2099-01-01-9.9.8-release-gate.json'), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: {} }));
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ ...metricRow(101), measure_version: MEASURE_VERSION }));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { stress: { id: 'stress', status: 'ok' } }, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(
      stress.every((c: { verdict: string }) => c.verdict === 'no-compatible-prior'),
      'with no earlier report carrying the step, every row has no compatible prior'
    );
    assert.equal((report.prior_from as Record<string, string>).stress, undefined);
  });
});

describe('priorStepLookup: measure_version, the absent-stamp trap and a real mismatch', () => {
  const metricRow = (n: number) =>
    identifiedRun({
      cold_crawl_ms: n,
      version_canary_ms: 20,
      warm_query_ms: 50,
      find_ms: 60,
      find_row_tokens: 71,
      cold_embed_ms: 200,
      semantic_find_ms: 70,
      map_ms: 80,
      map_tokens: 496,
      peek_ms: 90,
      peek_tokens: 581,
      related_ms: 100,
      related_tokens: 50,
      largest_note_tokens: 1000,
      bulk_change_ms: 500,
      bulk_watch_ms: 150,
      inproc: { cold_build_ms: n * 2, open_nochange_ms: 35, update_1_file_ms: 40, update_10_files_ms: 45 },
    });

  it('an older report whose step has no measure_version resolves as a prior against current m2 (must NOT be no-prior)', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { stress: { cold_crawl_ms: 100 } } } }];
    const hit = priorStepLookup(priorReports, 'm2')('stress');
    assert.deepEqual(hit, { step: { cold_crawl_ms: 100 }, from: 'old.json' });
  });

  it('a prior stamped m1 against current m2 resolves to no-prior, naming both versions', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { stress: { cold_crawl_ms: 100, measure_version: 'm1' } } } }];
    const hit = priorStepLookup(priorReports, 'm2')('stress');
    assert.deepEqual(hit, { step: null, from: 'old.json', mismatch: { prior: 'm1', current: 'm2' } });
  });

  it('fixture: a step that started and never settled blocks the sitting, named in the verdict', async () => {
    const reportsDir = scratchDir('interrupted-reports');
    const sitting = scratchDir('interrupted-sitting');
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ ...metricRow(100), measure_version: MEASURE_VERSION }));
    writeFileSync(join(sitting, 'battery-turso-hub.log'), 'partial output, then the kill\n'); // the log exists, the status never got written
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { stress: { status: 'ok' } }, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK', 'an interrupted sitting measured nothing past the kill and must not pass');
    assert.ok(
      (report.verdict_reasons as string[]).some((r) => r.startsWith('battery-turso-hub: started, never finished')),
      `the unfinished step is named: ${JSON.stringify(report.verdict_reasons)}`
    );
  });

  it('fixture: a report-wide m1/m2 mismatch classifies every row no-prior and records prior_harness_mismatch', async () => {
    const reportsDir = scratchDir('measure-version-mismatch-reports');
    const sitting = scratchDir('measure-version-mismatch-sitting');
    writeFileSync(join(reportsDir, '2099-01-01-9.9.8-release-gate.json'), JSON.stringify({ date: '2099-01-01', verdict: 'PASS', generated: true, classifications: [], accepted: {}, steps: { stress: { ...metricRow(100), measure_version: 'm1' } } }));
    writeFileSync(join(sitting, 'stress.json'), JSON.stringify({ ...metricRow(101), measure_version: MEASURE_VERSION }));
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { stress: { id: 'stress', status: 'ok' } }, failed_stage_reasons: [] }));

    const { buildReport } = await import('../../benchmark/report.mjs');
    const report = buildReport(sitting, { reportsDir });
    const stress = report.classifications.filter((c: { context: string }) => c.context === 'stress');
    assert.ok(
      stress.every((c: { verdict: string }) => c.verdict === 'no-compatible-prior'),
      'a real harness-version mismatch must classify every row without a compatible prior'
    );
    assert.deepEqual((report.prior_harness_mismatch as Record<string, unknown>).stress, { prior: 'm1', current: MEASURE_VERSION });
  });

  it('an artifact with no measure_version stamp is a prior mismatch at the current version (PLAN.md 3.42: the m2->m3 bump made this the permanent case for an unstamped step)', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { compare: metricRow(100) } } }];
    const hit = priorStepLookup(priorReports, MEASURE_VERSION)('compare');
    assert.deepEqual(hit, { step: null, from: 'old.json', mismatch: { prior: 'm2', current: MEASURE_VERSION } });
  });

  it('an artifact stamped with the current measure_version is not a mismatch', () => {
    const priorReports = [{ name: 'old.json', report: { steps: { compare: { ...metricRow(100), measure_version: MEASURE_VERSION } } } }];
    const hit = priorStepLookup(priorReports, MEASURE_VERSION)('compare');
    assert.deepEqual(hit, { step: { ...metricRow(100), measure_version: MEASURE_VERSION }, from: 'old.json' });
  });
});

describe('gate resume: a stage failure never disappears from the report', () => {
  // The defect this guards: a step read as done on resume when its out JSON existed, and a failed
  // step writes one too, so the 0.23.0 store-dump failure resumed as `ok` and left the report.
  const failed = { id: 'store-dump', status: 'failed' };

  it("a failed step's out file does not read as done on resume", async () => {
    const { doneOnResume, failedStageReasons } = await import('../../benchmark/report.mjs');
    const sitting = scratchDir('resume-failed-out');
    writeFileSync(join(sitting, 'store-dump.json'), JSON.stringify({ baseline: '9.9.8', ok: false, output: '' })); // a failed step's own out file
    assert.ok(existsSync(join(sitting, 'store-dump.json')), 'sanity: the failed step wrote an out file');
    assert.equal(doneOnResume('store-dump', failed), false, 'the recorded status decides, not the out file');
    assert.deepEqual(failedStageReasons({ 'store-dump': failed }), ['store-dump: failed']);
  });

  it('a step recorded ok is done; an accepted failure stays failed rather than re-running', async () => {
    const { doneOnResume } = await import('../../benchmark/report.mjs');
    assert.equal(doneOnResume('store-dump', { id: 'store-dump', status: 'ok' }), true);
    assert.equal(doneOnResume('store-dump', failed, new Set(['store-dump: failed'])), true, "an accepted failure is the owner's decision to keep it");
    assert.equal(doneOnResume('store-dump', failed, new Set(['store-dump: timeout'])), false, 'accepting one failure does not accept a different one');
    assert.equal(doneOnResume('store-dump', undefined), false, 'a step no earlier run recorded is never done');
    assert.equal(doneOnResume('compare', { status: 'not-run' }), false, 'a step an earlier failure left unreached is never done');
  });

  it('names the prerequisites that blocked an unmeasured step', async () => {
    const { unmeasuredSteps } = await import('../../benchmark/report.mjs');
    assert.deepEqual(unmeasuredSteps({ steps: { compare: { id: 'compare', status: 'not-run', blocked_by: ['validate', 'npm-test'] } } }), ['compare: not run (blocked by validate, npm-test); run the gate again to resume it']);
    assert.deepEqual(unmeasuredSteps({ steps: { compare: { id: 'compare', status: 'not-run' } } }), ['compare: not run (the gate stopped at an earlier failure); run the gate again to resume it']);
  });

  it("a failed stage's reason survives a resume into the report", async () => {
    const { buildReport, failedStageReasons } = await import('../../benchmark/report.mjs');
    const reportsDir = scratchDir('resume-failed-reports');
    const sitting = scratchDir('resume-failed-sitting');
    // What gate.mjs carries across a resume: the recorded status untouched, the reasons recomputed.
    mkdirSync(join(sitting, 'store-dump-captures', 'before'), { recursive: true });
    mkdirSync(join(sitting, 'store-dump-captures', 'after'), { recursive: true });
    writeFileSync(join(sitting, 'store-dump-captures', 'before', 'fixture.txt'), 'fixture\n');
    writeFileSync(join(sitting, 'store-dump-captures', 'after', 'fixture.txt'), 'fixture\n');
    writeFileSync(
      join(sitting, 'store-dump.json'),
      JSON.stringify({
        baseline: '9.9.8',
        ok: false,
        captures: { before: 'store-dump-captures/before', after: 'store-dump-captures/after' },
        capture_identity: { before: { sha256: 'fixture', files: [] }, after: { sha256: 'fixture', files: [] } },
        stores: Object.fromEntries(['sqlite', 'duckdb', 'turso'].map((store) => [store, { ok: false, artifacts: ['tables.txt'], files: { 'tables.txt': { equal: false } } }])),
        diff: { changed_files: [], categories: {} },
      })
    );
    const completeSteps = {
      validate: { id: 'validate', status: 'ok' },
      'npm-test': { id: 'npm-test', status: 'ok' },
      'test-engines': { id: 'test-engines', status: 'not-owed' },
      'live-suite': { id: 'live-suite', status: 'not-owed' },
      'store-dump': { ...failed, owed: true, resumed: true },
      compare: { id: 'compare', status: 'not-owed' },
    };
    writeFileSync(join(sitting, 'sitting.json'), JSON.stringify({ date: '2099-01-03', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: { 'store-dump': ['fixture'] }, steps: completeSteps, failed_stage_reasons: failedStageReasons(completeSteps) }));

    const report = buildReport(sitting, { reportsDir });
    assert.equal(report.verdict, 'BLOCK', 'a failure the owner has not accepted still blocks after a resume');
    assert.ok(report.verdict_reasons.some((reason: string) => reason === 'store-dump: failed'));
    assert.deepEqual(report.stage_reasons, ['store-dump: failed']);
  });
});

describe('gate step orchestration', () => {
  it('runs real Node children, retains optional failure artifacts, and stops downstream work', async () => {
    for (const writesArtifact of [false, true]) {
      const sitting = scratchDir('gate-step-failure');
      const artifact = join(sitting, 'failed.json');
      const downstream = join(sitting, 'downstream.txt');
      const steps = [
        { id: 'failed', argv: [process.execPath, '-e', writesArtifact ? `require('fs').writeFileSync(${JSON.stringify(artifact)}, '{}'); process.exit(7)` : 'process.exit(7)'] },
        { id: 'downstream', argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(downstream)}, 'ran')`] },
      ];
      const statuses: Record<string, string> = {};
      const result = await runStageSteps(steps, {
        isOwed: () => true,
        resume: () => null,
        run: (step: { argv: string[] }) => {
          const child = spawnSync(step.argv[0], step.argv.slice(1), { encoding: 'utf8', timeout: 10_000 });
          return { status: child.status === 0 ? 'ok' : 'failed', code: child.status };
        },
        recordNotOwed: () => {},
        recordResume: () => {},
        recordResult: (step: { id: string }, child: { status: string }) => (statuses[step.id] = child.status),
      });
      assert.equal(result.failed, true);
      assert.deepEqual(statuses, { failed: 'failed' });
      assert.equal(existsSync(artifact), writesArtifact);
      assert.equal(existsSync(downstream), false);
    }
  });

  it('keeps a selected scratch sitting acceptance through two real orchestration resumes', async () => {
    const sitting = scratchDir('gate-report-transition');
    const otherSitting = scratchDir('gate-report-transition-other');
    const steps: Record<string, { id: string; status: string; resumed?: boolean }> = Object.fromEntries(buildStages().flatMap((stage) => stage.steps.map((step) => [step.id, { id: step.id, status: step.id === 'validate' ? 'failed' : step.id === 'npm-test' ? 'not-run' : step.owedBy === 'always' ? 'ok' : 'not-owed' }])));
    const sittingPath = join(sitting, 'sitting.json');
    const childRuns: string[] = [];
    const transitionSteps = [
      { id: 'validate', exit: 7 },
      { id: 'npm-test', exit: 0 },
    ];
    const execute = (accepted = new Set<string>()) =>
      runStageSteps(transitionSteps, {
        isOwed: () => true,
        resume: (step: { id: string }) => (doneOnResume(step.id, steps[step.id], accepted) ? steps[step.id] : null),
        run: (step: { id: string; exit: number }) => {
          childRuns.push(step.id);
          const child = spawnSync(process.execPath, ['-e', `process.exit(${step.exit})`], { encoding: 'utf8', timeout: 10_000 });
          return { status: child.status === 0 ? 'ok' : 'failed' };
        },
        recordNotOwed: () => {},
        recordResume: (step: { id: string }, recorded: { id: string; status: string; resumed?: boolean }) => {
          steps[step.id] = { ...recorded, resumed: true };
        },
        recordResult: (step: { id: string }, child: { status: string }) => {
          steps[step.id] = { id: step.id, status: child.status };
          return child.status;
        },
      });
    assert.deepEqual(await execute(), { failed: true, step: transitionSteps[0], status: 'failed' });
    assert.deepEqual(childRuns, ['validate']);
    writeFileSync(sittingPath, JSON.stringify({ date: '2099-03-01', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps, failed_stage_reasons: ['validate: failed'] }));
    const reportCli = join(packageRoot, 'benchmark', 'report.mjs');
    let rendered = spawnSync(process.execPath, [reportCli, '--sitting', sitting], { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const reportPath = join(sitting, 'release-gate.json');
    writeFileSync(join(otherSitting, 'release-gate.json'), readFileSync(reportPath));
    const otherBefore = readFileSync(join(otherSitting, 'release-gate.json'), 'utf8');
    execFileSync(process.execPath, [reportCli, '--accept', 'validate: failed', '--reason', 'fixture owner decision', '--sitting', sitting], { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(readFileSync(join(otherSitting, 'release-gate.json'), 'utf8'), otherBefore);
    rendered = spawnSync(process.execPath, [reportCli, '--sitting', sitting], { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(rendered.status, 0, rendered.stderr);
    const accepted = JSON.parse(readFileSync(reportPath, 'utf8')).accepted['validate: failed'];
    for (let resume = 0; resume < 2; resume++) {
      const acceptedSet = acceptedIds(sitting);
      assert.ok(acceptedSet.has('validate: failed'));
      assert.deepEqual(await execute(acceptedSet), { failed: false });
      writeFileSync(sittingPath, JSON.stringify({ date: '2099-03-01', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps, failed_stage_reasons: ['validate: failed'] }));
      rendered = spawnSync(process.execPath, [reportCli, '--sitting', sitting], { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 });
      assert.equal(rendered.status, 0, rendered.stderr);
      const report = JSON.parse(readFileSync(reportPath, 'utf8'));
      assert.equal(report.verdict, 'PASS');
      assert.deepEqual(report.accepted['validate: failed'], accepted);
      assert.equal(report.steps_status.validate.resumed, true);
    }
    assert.deepEqual(childRuns, ['validate', 'npm-test']);
  });
});

describe('gate reversed compare transition policy', () => {
  const moved = {
    versions: ['prior', 'local'],
    results: { prior: { map_ms: 10, workload_identity: { logical_inputs: { rows: { map_ms: { inputs: { x: 1 }, fingerprint: identityHash({ x: 1 }) } } } } }, local: { map_ms: 30, workload_identity: { logical_inputs: { rows: { map_ms: { inputs: { x: 1 }, fingerprint: identityHash({ x: 1 }) } } } } } },
  };
  it('runs missing and failed reversed evidence, stops on success, and stops after accepted failure', () => {
    assert.equal(reversedCompareAction(moved, undefined, { resuming: true }), 'run');
    assert.equal(reversedCompareAction(moved, { status: 'failed' }, { resuming: true }), 'run');
    assert.equal(reversedCompareAction(moved, { status: 'ok' }, { resuming: true }), 'done');
    assert.equal(reversedCompareAction(moved, { status: 'failed' }, { resuming: true, accepted: new Set(['compare-reversed: failed']) }), 'accepted');
    assert.equal(reversedCompareAction({ versions: ['prior', 'local'], results: { prior: { map_ms: 10 }, local: { map_ms: 10 } } }, undefined, { resuming: true }), 'not-needed');
  });

  it('routes each required reversed transition through the real child runner', async () => {
    for (const writesArtifact of [false, true]) {
      const scratch = scratchDir('gate-reversed-runner');
      const artifact = join(scratch, 'compare-reversed.json');
      const sittingPath = join(scratch, 'sitting.json');
      let recorded: { id: string; status: string } | undefined;
      let childRuns = 0;
      const attempt = async (exit: number) =>
        runStageSteps([{ id: 'compare-reversed' }], {
          isOwed: () => true,
          resume: () => null,
          run: () => {
            childRuns++;
            const script = exit === 0 ? 'process.exit(0)' : `${writesArtifact ? `require('fs').writeFileSync(${JSON.stringify(artifact)}, '{}');` : ''} process.exit(${exit})`;
            const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10_000 });
            return { status: child.status === 0 ? 'ok' : 'failed' };
          },
          recordNotOwed: () => {},
          recordResume: () => {},
          recordResult: (step: { id: string }, child: { status: string }) => {
            recorded = { id: step.id, status: child.status };
            return child.status;
          },
        });

      assert.equal(reversedCompareAction(moved, recorded, { resuming: true }), 'run');
      assert.equal((await attempt(7)).failed, true);
      writeFileSync(sittingPath, JSON.stringify({ steps: { 'compare-reversed': recorded } }));
      recorded = JSON.parse(readFileSync(sittingPath, 'utf8')).steps['compare-reversed'];
      assert.equal(recorded?.status, 'failed');
      assert.equal(existsSync(artifact), writesArtifact);
      assert.equal(reversedCompareAction(moved, recorded, { resuming: true }), 'run');
      assert.equal((await attempt(0)).failed, false);
      writeFileSync(sittingPath, JSON.stringify({ steps: { 'compare-reversed': recorded } }));
      recorded = JSON.parse(readFileSync(sittingPath, 'utf8')).steps['compare-reversed'];
      assert.equal(recorded?.status, 'ok');
      assert.equal(reversedCompareAction(moved, recorded, { resuming: true }), 'done');
      assert.equal(childRuns, 2);
    }
  });
});

describe('quality artifacts carry the current harness stamp (PLAN.md 3.42)', () => {
  it('the runtime artifact builder stamps both supported query forms with MEASURE_VERSION', () => {
    const qids = ['q1'];
    const queries = new Map([['q1', 'alpha beta']]);
    const qrels = new Map([['q1', new Map([['doc', 1]])]]);
    for (const queryForm of ['or-bag', 'bare-and'] as const) {
      const queryFor = queryFormFor(queryForm);
      if (queryFor === null) throw new Error(`unsupported fixture query form: ${queryForm}`);
      const artifact = buildQualityArtifactBase({ corpus: 'fixture', split: 'test', qids, k: 1, store: 'sqlite', source: 'fixture-source', tree: 'fixture-tree', measureVersion: MEASURE_VERSION, queries, qrels, queryForm, queryFor });
      assert.equal(artifact.measure_version, MEASURE_VERSION, `${queryForm}: runtime artifact stamp`);
    }
  });
});

describe('capability assessment report evidence boundaries', () => {
  const sitting = (dir: string, steps: Record<string, unknown>) => {
    writeFileSync(
      join(dir, 'sitting.json'),
      JSON.stringify({ date: '2099-09-09', baseline_version: '9.9.9', last_tag: 'v9.9.8', machine: { cpu_model: 'Fixture' }, node: 'v99', changed_paths: [], owed: {}, steps: { validate: { id: 'validate', status: 'ok' }, 'npm-test': { id: 'npm-test', status: 'ok' }, ...steps }, failed_stage_reasons: [] })
    );
  };

  it('keeps finite failed or unrecorded measurements out of report comparisons', () => {
    for (const status of ['failed', undefined]) {
      const dir = scratchDir(`report-status-${status ?? 'missing'}`);
      writeFileSync(join(dir, 'stress.json'), JSON.stringify({ bulk_change_ms: 400, bulk_watch_ms: 100, measure_version: MEASURE_VERSION }));
      sitting(dir, status === undefined ? {} : { stress: { id: 'stress', status } });
      const report = buildReport(dir, { reportsDir: scratchDir('report-status-reports') });
      assert.ok(report.verdict_reasons.some((reason: string) => reason.includes(`stress: recorded step status ${status ?? 'missing'}`)));
      assert.ok(!report.classifications.some((row) => row.context === 'stress' && Number.isFinite(row.current)), 'raw finite values must not enter a comparison');
      assert.ok(!renderMarkdown(report).includes('| stress |'), 'raw finite values must not enter rendered tables');
    }
  });

  it('surfaces an invalid attached matrix without trusting its valid flag', () => {
    const dir = scratchDir('report-invalid-matrix-sitting');
    const matrix = join(scratchDir('report-invalid-matrix'), 'matrix.json');
    sitting(dir, {});
    writeFileSync(matrix, JSON.stringify({ schema: 'native-evidence-matrix-v1', status: 'success', valid: true, second_baseline_notes: 6, records: [] }));
    const report = buildReport(dir, { reportsDir: scratchDir('report-invalid-matrix-reports'), nativeMatrixPath: matrix });
    assert.match(report.assessment.current_native_capabilities.error, /coverage differs/);
    assert.match(renderMarkdown(report), /No validated native matrix was used/);
  });

  it('--out writes an isolated analysis and rejects release or acceptance mutations', () => {
    const dir = scratchDir('report-out-source');
    const out = scratchDir('report-out-target');
    sitting(dir, {});
    const source = join(dir, 'release-gate.json');
    writeFileSync(source, '{"preserve":"source"}\n');
    const run = (args: string[]) => spawnSync(process.execPath, ['benchmark/report.mjs', '--sitting', dir, ...args], { cwd: packageRoot, encoding: 'utf8' });
    const isolated = run(['--out', out]);
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.equal(readFileSync(source, 'utf8'), '{"preserve":"source"}\n');
    assert.ok(existsSync(join(out, 'release-gate.json')));
    assert.notEqual(run(['--out', out, '--release', '9.9.9']).status, 0);
    assert.notEqual(run(['--out', out, '--accept', 'x', '--reason', 'x']).status, 0);
  });
});
