import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { signalProcessTree } from '../../benchmark/lib/native-observer.mjs';
import { observeQualityModel, prepareQualityWorkTree } from '../../benchmark/lib/quality-work-tree.mjs';
import { writeModel } from '../lib/model.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { forEachStore, openTreeForStore, type ParityStoreName } from '../lib/stores.ts';

async function runQualityStep(root: string, store: ParityStoreName, model: string, out: string): Promise<string> {
  const child = spawn(process.execPath, [join(root, 'benchmark', 'steps', 'quality.mjs'), 'nfcorpus', '--queries', '1', '--k', '1', '--query-form', 'bare-and', '--store', store, '--model', model, '--out', out], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  let outputBytes = 0;
  let timedOut = false;
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= 1024 * 1024) stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= 1024 * 1024) stderr += chunk;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timeoutError: unknown = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      signalProcessTree(child, 'SIGKILL');
    } catch (err) {
      timeoutError = err;
    }
  }, 30_000);
  const result = await (async () => {
    try {
      return await closed;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (timeoutError) throw timeoutError;
  assert.equal(timedOut, false, `${store} quality step timed out`);
  assert.equal(outputBytes <= 1024 * 1024, true, `${store} quality step exceeded its output bound`);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  return stdout;
}

function sourceTree(): string {
  const source = scratchDir('quality-source');
  writeFileSync(join(source, 'a.md'), '# Alpha\n\nneedle alpha\n');
  writeFileSync(join(source, 'b.md'), '# Beta\n\nneedle beta\n');
  return source;
}

function cacheInputs(store: ParityStoreName, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    config: { preset: 'default', signals: { words: 1 } },
    store,
    dist: { version: 'fixture-dist' },
    native: { package: `${store}-fixture`, version: '1' },
    model: { provider: 'static', fingerprint: 'fixture-model' },
    ...changes,
  };
}

async function seedPublished(store: ParityStoreName, workRoot: string, key: string, source: string, inputs = cacheInputs(store)) {
  const prepared = prepareQualityWorkTree({ workRoot, key, source, cacheInputs: inputs, reuseEligible: true });
  try {
    const opened = await openTreeForStore(store, prepared.tree);
    try {
      assert.ok(opened.store);
    } finally {
      await opened.store.close();
    }
    return { prepared, published: prepared.publish() };
  } catch (err) {
    prepared.discard(err);
    throw err;
  }
}

describe('quality cache work trees', () => {
  it('rejects cache keys that can escape their private namespace', () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-invalid-key');
    assert.throws(() => prepareQualityWorkTree({ workRoot, key: '../outside', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true }), /invalid quality cache key/);
  });

  it('copies concurrent runs into unique private trees and discards both failed runs', () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-work-root');
    const inputs = cacheInputs('sqlite');
    const runs = [prepareQualityWorkTree({ workRoot, key: 'same-key', source, cacheInputs: inputs, reuseEligible: true }), prepareQualityWorkTree({ workRoot, key: 'same-key', source, cacheInputs: inputs, reuseEligible: true })];

    assert.notEqual(runs[0].tree, runs[1].tree);
    assert.equal(runs[0].reuse_state, 'source-copy');
    assert.equal(runs[1].reuse_state, 'source-copy');
    assert.equal(runs[0].reused_generation, null);
    assert.equal(runs[1].reused_generation, null);
    assert.throws(() => runs[0].discard(new Error('quality run failed')), /quality run failed/);
    assert.throws(() => runs[1].discard(new Error('quality run failed')), /quality run failed/);
    assert.equal(readFileSync(join(source, 'a.md'), 'utf8'), '# Alpha\n\nneedle alpha\n');
  });

  it('publishes one immutable completed generation and reuses its native cache', async () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-publish-root');
    const { published } = await seedPublished('sqlite', workRoot, 'sqlite-key', source);
    const reused = prepareQualityWorkTree({ workRoot, key: 'sqlite-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true });

    assert.equal(reused.reuse_state, 'copied-completed-index');
    assert.equal(reused.reused_generation, published.tree);
    assert.notEqual(reused.tree, published.tree);
    try {
      const opened = await openTreeForStore('sqlite', reused.tree);
      try {
        assert.ok(opened.store);
      } finally {
        await opened.store.close();
      }
    } finally {
      reused.discard();
    }
  });

  it('does not reuse a completed generation when source or any workload identity changes', async () => {
    const fields: Array<[string, Record<string, unknown>]> = [
      ['config', { config: { preset: 'other', signals: { words: 1 } } }],
      ['store', { store: 'duckdb' }],
      ['dist', { dist: { version: 'different-dist' } }],
      ['native', { native: { package: 'sqlite-fixture', version: '2' } }],
      ['model', { model: { provider: 'static', fingerprint: 'different-model' } }],
    ];

    for (const [name, change] of fields) {
      const source = sourceTree();
      const workRoot = scratchDir(`quality-identity-${name}`);
      await seedPublished('sqlite', workRoot, 'identity-key', source);
      const changed = prepareQualityWorkTree({ workRoot, key: 'identity-key', source, cacheInputs: cacheInputs('sqlite', change), reuseEligible: true });
      assert.equal(changed.reuse_state, 'source-copy', `${name} changed an identity that must invalidate reuse`);
      assert.equal(changed.reused_generation, null, `${name} changed an identity that must invalidate reuse`);
      assert.notEqual(changed.cacheFingerprint, undefined);
      changed.discard();
    }

    const source = sourceTree();
    const workRoot = scratchDir('quality-identity-source');
    await seedPublished('sqlite', workRoot, 'source-key', source);
    writeFileSync(join(source, 'a.md'), '# Alpha\n\nchanged source\n');
    const changedSource = prepareQualityWorkTree({ workRoot, key: 'source-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true });
    assert.equal(changedSource.reuse_state, 'source-copy');
    assert.equal(changedSource.reused_generation, null);
    changedSource.discard();
  });

  it('rejects changed native cache files instead of trusting a matching corpus', async () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-native-integrity');
    const { published } = await seedPublished('sqlite', workRoot, 'integrity-key', source);
    const senseDir = join(published.tree, '.sense');
    const nativeFile = readdirSync(senseDir).find((name) => statSync(join(senseDir, name)).isFile());
    assert.ok(nativeFile);
    writeFileSync(join(senseDir, nativeFile), 'corrupt native cache');
    assert.throws(() => prepareQualityWorkTree({ workRoot, key: 'integrity-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true }), /native files changed/);
  });

  it('rejects a malformed completion marker instead of treating it as a finished run', async () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-marker-root');
    const { published } = await seedPublished('sqlite', workRoot, 'marker-key', source);
    writeFileSync(join(published.tree, '.quality-cache.json'), '{"version":1}');

    assert.throws(() => prepareQualityWorkTree({ workRoot, key: 'marker-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true }), /malformed completion marker/);
  });

  it('does not hash native files for a preserved generation with a different identity', async () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-unmatched-generation');
    const { published } = await seedPublished('sqlite', workRoot, 'unmatched-key', source);
    const markerPath = join(published.tree, '.quality-cache.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    delete marker.sense_manifest;
    writeFileSync(markerPath, JSON.stringify(marker));
    const changed = prepareQualityWorkTree({ workRoot, key: 'unmatched-key', source, cacheInputs: cacheInputs('sqlite', { config: { preset: 'changed' } }), reuseEligible: true });
    assert.equal(changed.reuse_state, 'source-copy');
    changed.discard();
  });

  it('bypasses corrupt history when reuse is explicitly ineligible', async () => {
    const source = sourceTree();
    const workRoot = scratchDir('quality-ineligible-history');
    const { published } = await seedPublished('sqlite', workRoot, 'ineligible-key', source);
    writeFileSync(join(published.tree, '.quality-cache.json'), 'not json');
    const fresh = prepareQualityWorkTree({ workRoot, key: 'ineligible-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: false });
    assert.equal(fresh.reuse_state, 'source-copy');
    fresh.discard();
  });

  it('refuses to publish an empty native cache', () => {
    const source = sourceTree();
    const prepared = prepareQualityWorkTree({ workRoot: scratchDir('quality-empty-native'), key: 'empty-key', source, cacheInputs: cacheInputs('sqlite'), reuseEligible: true });
    try {
      assert.throws(() => prepared.publish(), /produced no native cache files/);
    } finally {
      prepared.discard();
    }
  });

  it('observes model bytes even when a replacement keeps the same mtime', async () => {
    const model = writeModel();
    const embed = { provider: 'static', model } as const;
    const before = await observeQualityModel(packageRoot, embed);
    assert.equal(before.reuse_eligible, true);
    if (!before.files) assert.fail('eligible model observation must include file identities');
    const modelPath = join(model, 'model.safetensors');
    const original = statSync(modelPath);
    const bytes = readFileSync(modelPath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(modelPath, bytes);
    utimesSync(modelPath, original.atime, original.mtime);
    const after = await observeQualityModel(packageRoot, embed);

    assert.equal(after.reuse_eligible, true);
    if (!after.files) assert.fail('eligible model observation must include file identities');
    assert.notEqual(after.files['model.safetensors'].sha256, before.files['model.safetensors'].sha256);
    assert.notEqual(after.fingerprint, before.fingerprint);
  });

  it('carries a real completed native cache through reuse for every store', async function () {
    this.timeout(60_000);
    await forEachStore(async (store) => {
      const source = sourceTree();
      const workRoot = scratchDir(`quality-native-${store}`);
      await seedPublished(store, workRoot, `${store}-key`, source);
      const reused = prepareQualityWorkTree({ workRoot, key: `${store}-key`, source, cacheInputs: cacheInputs(store), reuseEligible: true });

      assert.equal(reused.reuse_state, 'copied-completed-index', `${store}: completed cache must be reused`);
      assert.notEqual(reused.tree, reused.reused_generation, `${store}: reuse must get a private tree`);
      try {
        const opened = await openTreeForStore(store, reused.tree);
        try {
          assert.ok(opened.store);
        } finally {
          await opened.store.close();
        }
      } finally {
        reused.discard();
      }
    });
  });

  it('runs the real quality entrypoint twice per store with private verified reuse', async function () {
    this.timeout(120_000);
    const root = scratchDir('quality-step-sandbox');
    cpSync(join(packageRoot, 'benchmark'), join(root, 'benchmark'), { recursive: true });
    cpSync(join(packageRoot, 'dist'), join(root, 'dist'), { recursive: true });
    cpSync(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(packageRoot, 'package.json'), join(root, 'package.json'));
    symlinkSync(join(packageRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
    const corpus = join(root, '.tmp', 'cache', 'nfcorpus-beir-1');
    mkdirSync(join(corpus, 'tree'), { recursive: true });
    mkdirSync(join(corpus, 'labels'), { recursive: true });
    writeFileSync(join(corpus, 'tree', 'a.md'), '# Alpha\n\napple target\n');
    writeFileSync(join(corpus, 'tree', 'b.md'), '# Beta\n\nstone distractor\n');
    writeFileSync(join(corpus, 'labels', 'queries.jsonl'), '{"_id":"q1","text":"apple"}\n');
    writeFileSync(join(corpus, 'labels', 'test.tsv'), 'query-id\tcorpus-id\tscore\nq1\ta\t1\n');
    const model = writeModel();

    await forEachStore(async (store) => {
      const firstOut = join(root, `${store}-first.json`);
      const secondOut = join(root, `${store}-second.json`);
      const firstStdout = await runQualityStep(root, store, model, firstOut);
      const secondStdout = await runQualityStep(root, store, model, secondOut);
      const first = JSON.parse(readFileSync(firstOut, 'utf8'));
      const second = JSON.parse(readFileSync(secondOut, 'utf8'));
      assert.equal(first.incomplete, false);
      assert.equal(first.no_silent_change, true);
      assert.match(firstStdout, /no-silent-change: ok/);
      assert.match(secondStdout, /no-silent-change: ok/);
      assert.deepEqual(Object.keys(first.variants), ['bm25-only', 'fused', 'semantic']);
      for (const artifact of [first, second]) {
        for (const variant of Object.values(artifact.variants) as Array<{ ndcg: number; rr: number; hit: number; per_query: Record<string, { paths: string[] }> }>) {
          assert.deepEqual({ ndcg: variant.ndcg, rr: variant.rr, hit: variant.hit }, { ndcg: 1, rr: 1, hit: 1 });
          assert.deepEqual(variant.per_query.q1.paths, ['a.md']);
        }
      }
      assert.equal(first.cache.reuse_state, 'source-copy');
      assert.equal(second.cache.reuse_state, 'copied-completed-index');
      assert.notEqual(first.work_tree, second.work_tree);
      assert.equal(second.cache.cache_fingerprint, first.cache.cache_fingerprint);
    });
  });
});
