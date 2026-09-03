import assert from 'assert';
import { enabledFeatures } from '../../../src/config/access.ts';
import { FEATURE_HOOKS, FIXED_STAGES, STAGES_VERSION, type Stages, stageRecorder, unaccountedMs } from '../../../src/store/stages.ts';
import { scratchDir } from '../../lib/scratch.ts';
import { forEachStore, openTreeForStore } from '../../lib/stores.ts';
import { writeNote } from '../../lib/tree.ts';

// The stage vocabulary is a published contract (STAGES_VERSION), read across releases and across
// stores, so these specs pin the key set and the disjointness the residual depends on.

function tree(): string {
  const dir = scratchDir('stages');
  writeNote(dir, 'a.md', { frontmatter: { tags: ['x'] }, body: 'links to [[b]] and #inline' });
  writeNote(dir, 'b.md', { frontmatter: { title: 'B' }, body: 'plain body' });
  return dir;
}

function expectedKeys(cfg: Parameters<typeof enabledFeatures>[0]): Set<string> {
  const keys = new Set<string>(FIXED_STAGES);
  for (const feature of enabledFeatures(cfg)) for (const hook of FEATURE_HOOKS) keys.add(`feature:${feature}:${hook}`);
  return keys;
}

describe('store/stages', () => {
  describe('recorder', () => {
    it('accumulates a stage entered more than once', async () => {
      const rec = stageRecorder();
      await rec.time('parse', () => undefined);
      await rec.time('parse', () => undefined);
      const stages = rec.take(10, 0);
      assert.strictEqual(typeof stages.spans.parse, 'number');
    });

    it('records nothing for a stage that threw', async () => {
      const rec = stageRecorder();
      await assert.rejects(() =>
        rec.time('parse', () => {
          throw new Error('boom');
        })
      );
      assert.strictEqual(rec.take(10, 0).spans.parse, 0);
    });

    it('reports every fixed stage even when none ran', () => {
      const stages = stageRecorder().take(10, 0);
      for (const stage of FIXED_STAGES) assert.strictEqual(stages.spans[stage], 0, `${stage} missing`);
    });

    it('unaccounted is the total less every span', () => {
      const stages: Stages = { version: STAGES_VERSION, totalMs: 100, txMs: 40, parseWorkerMs: 200, spans: { list: 10, parse: 30 } };
      assert.strictEqual(unaccountedMs(stages), 60);
    });
  });

  describe('a real build', () => {
    // The parity case: one reconcile serves every store with the dialect as a parameter, so the
    // key set must not vary by store. A store-shaped difference here means an untimed dialect hook.
    it('reports the same stage keys on every store', async () => {
      const seen: Array<{ store: string; keys: string[]; stages: Stages }> = [];
      await forEachStore(async (store) => {
        const dir = tree();
        const opened = await openTreeForStore(store, dir);
        seen.push({ store, keys: Object.keys(opened.stages.spans).sort(), stages: opened.stages });
        await opened.store.close();
      });
      assert.ok(seen.length >= 1, 'no store ran');
      const [first, ...rest] = seen;
      for (const other of rest) assert.deepStrictEqual(other.keys, first.keys, `${other.store} differs from ${first.store}`);
    });

    it('reports exactly the declared vocabulary, and spans that never exceed the total', async () => {
      await forEachStore(async (store) => {
        const dir = tree();
        const opened = await openTreeForStore(store, dir);
        const { stages, cfg } = opened;
        assert.strictEqual(stages.version, STAGES_VERSION, `${store} version`);
        assert.deepStrictEqual(new Set(Object.keys(stages.spans)), expectedKeys(cfg), `${store} key set`);
        // Disjoint spans are what makes the residual meaningful; overlap would read as negative.
        assert.ok(unaccountedMs(stages) >= 0, `${store} spans exceed the total by ${-unaccountedMs(stages)} ms`);
        assert.ok(stages.totalMs > 0, `${store} total`);
        assert.ok(stages.spans.parse > 0, `${store} parse`);
        await opened.store.close();
      });
    });

    // The pool threshold is where the worker sum appears; either side of it the residual must stay
    // non-negative, which a two-note tree can never show since it always takes the serial path.
    for (const [count, pooled] of [
      [199, false],
      [201, true],
    ] as const) {
      it(`keeps the residual non-negative at ${count} files (${pooled ? 'pooled' : 'serial'})`, async () => {
        const dir = scratchDir('stages-threshold');
        for (let i = 0; i < count; i++) writeNote(dir, `n${i}.md`, { frontmatter: { title: `N${i}` }, body: `note ${i} links [[n${(i + 1) % count}]]` });
        const opened = await openTreeForStore('sqlite', dir);
        const { stages } = opened;
        assert.strictEqual(stages.parseWorkerMs > 0, pooled, `parseWorkerMs ${stages.parseWorkerMs} at ${count} files`);
        assert.ok(unaccountedMs(stages) >= 0, `residual ${unaccountedMs(stages)} ms of ${stages.totalMs}`);
        assert.ok(unaccountedMs(stages) < stages.totalMs / 2, `residual ${unaccountedMs(stages)} ms is half the ${stages.totalMs} ms build`);
        await opened.store.close();
      });
    }

    it('reports stages for a reconcile with nothing to do', async () => {
      const dir = tree();
      const first = await openTreeForStore('sqlite', dir);
      await first.store.close();
      const second = await openTreeForStore('sqlite', dir);
      assert.strictEqual(second.parsed, 0);
      assert.strictEqual(second.stages.version, STAGES_VERSION);
      assert.strictEqual(second.stages.spans.parse, 0);
      assert.ok(second.stages.spans.existing >= 0);
      await second.store.close();
    });
  });
});
