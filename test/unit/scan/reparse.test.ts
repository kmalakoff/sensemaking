import assert from 'node:assert';
import type { Config } from 'sensemaking';
import { SenseError } from '../../../src/errors.ts';
import { FEATURES } from '../../../src/features/index.ts';
import type { Feature } from '../../../src/features/types.ts';
import { listFiles } from '../../../src/scan/index.ts';
import { reparseFiles } from '../../../src/scan/reparse.ts';
import { reviveError, serializeError } from '../../../src/scan/worker-error.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';
import { liveWorkerHandles } from '../../lib/worker-handles.ts';

const cfg: Config = { presets: { default: { include: ['**/*.md'] } }, queries: {} };

function noopFeature(name: Feature['name'], overrides: Partial<Feature> = {}): Feature {
  return { name, async schema() {}, ...overrides };
}

describe('reparseFiles', () => {
  it('collects new frontmatter columns in first-seen order across files, skipping already-known ones', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { zeta: 1, alpha: 2 } });
    writeNote(baseDir, 'b.md', { frontmatter: { alpha: 3, beta: 4 } });
    writeNote(baseDir, 'c.md', { frontmatter: { gamma: 5, zeta: 6 } });
    const files = listFiles(cfg, baseDir);

    const result = await reparseFiles(files, [], cfg, new Set(['alpha']));

    assert.deepEqual(result.newColumns, ['zeta', 'beta', 'gamma']);
    assert.deepEqual(
      result.docs.map((d) => d.relPath),
      ['a.md', 'b.md', 'c.md']
    );
  });

  it('does not mutate the knownColumns set passed in', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { fresh: 1 } });
    const files = listFiles(cfg, baseDir);
    const known = new Set(['other']);

    await reparseFiles(files, [], cfg, known);

    assert.deepEqual([...known], ['other']);
  });

  it('applies enabledForFile per file: a feature opted out for one file leaves no extracted entry for it', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'special/x.md', { frontmatter: { title: 'X' } });
    writeNote(baseDir, 'normal/y.md', { frontmatter: { title: 'Y' } });
    const files = listFiles(cfg, baseDir);

    const always = noopFeature('links', { extract: () => 'always' });
    const specialOnly = noopFeature('tags', {
      extract: () => 'special',
      enabledForFile: (_cfg, file) => file.relPath.startsWith('special/'),
    });

    const result = await reparseFiles(files, [always, specialOnly], cfg, new Set());
    const byPath = new Map(result.docs.map((d) => [d.relPath, d]));

    assert.equal(byPath.get('special/x.md')?.extracted.links, 'always');
    assert.equal(byPath.get('special/x.md')?.extracted.tags, 'special');
    assert.equal(byPath.get('normal/y.md')?.extracted.links, 'always');
    assert.ok(!('tags' in (byPath.get('normal/y.md')?.extracted ?? {})), 'opted-out feature leaves no extracted entry');
  });

  it('accumulates warnings in file order, including files that contribute none', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: 'created: 2024-13-40T99:99' }); // invalid date
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'clean' } }); // no warning
    writeNote(baseDir, 'c.md', { frontmatter: { path: 'reserved-collision' } }); // reserved key
    const files = listFiles(cfg, baseDir);

    const result = await reparseFiles(files, [], cfg, new Set());

    assert.deepEqual(result.warnings, ['warning: a.md: created is not a valid date (2024-13-40T99:99), so it is invisible to every date comparison', 'warning: c.md has a frontmatter key named "path", which is reserved; ignoring it']);
  });

  it('calls onParsed once per file, in order, with a running 1-based count', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    writeNote(baseDir, 'b.md');
    writeNote(baseDir, 'c.md');
    const files = listFiles(cfg, baseDir);
    const ticks: number[] = [];

    await reparseFiles(files, [], cfg, new Set(), (done) => ticks.push(done));

    assert.deepEqual(ticks, [1, 2, 3]);
  });

  it('an empty file list returns empty results and never calls onParsed', async () => {
    let called = false;
    const result = await reparseFiles([], [], cfg, new Set(), () => {
      called = true;
    });
    assert.deepEqual(result, { docs: [], warnings: [], newColumns: [], workerParseMs: 0 });
    assert.equal(called, false);
  });

  // threshold: 0 forces every file through the real tinypool pool, real worker threads, no
  // mocking. The two cases probe the shipped boundary itself: 199 files stay serial, 200 pool -- without them the constant could move to 2000, or the comparison flip to >, with the suite still green.
  describe('the shipped dispatch threshold (200 files)', () => {
    // Pooling is visible while it runs, not after: the pool holds one MessagePort per thread
    // and releases them on destroy, so the check samples during the dispatch.
    async function pooledDuring(fileCount: number): Promise<boolean> {
      const baseDir = tmpTree();
      for (let i = 0; i < fileCount; i++) writeNote(baseDir, `n${String(i).padStart(4, '0')}.md`);
      const files = listFiles(cfg, baseDir);
      assert.equal(files.length, fileCount, 'fixture did not produce the intended file count');

      const baseline = liveWorkerHandles();
      let sawWorkers = false;
      const dispatch = reparseFiles(files, [], cfg, new Set());
      const sampler = setInterval(() => {
        if (liveWorkerHandles() > baseline) sawWorkers = true;
      }, 1);
      try {
        await dispatch;
      } finally {
        clearInterval(sampler);
      }
      return sawWorkers;
    }

    it('stays serial one file below the threshold', async () => {
      assert.equal(await pooledDuring(199), false, '199 files spun up worker threads');
    });

    it('pools at the threshold', async () => {
      assert.equal(await pooledDuring(200), true, '200 files did not spin up worker threads');
    });
  });

  describe('pooled dispatch (threshold forced to 0)', () => {
    it('parses every file through worker threads, preserving file order in the result', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { frontmatter: { zeta: 1, alpha: 2 } });
      writeNote(baseDir, 'b.md', { frontmatter: { alpha: 3, beta: 4 } });
      writeNote(baseDir, 'c.md', { frontmatter: { gamma: 5, zeta: 6 } });
      const files = listFiles(cfg, baseDir);

      const result = await reparseFiles(files, [], cfg, new Set(['alpha']), undefined, { threshold: 0, maxWorkers: 2 });

      assert.deepEqual(result.newColumns, ['zeta', 'beta', 'gamma']);
      assert.deepEqual(
        result.docs.map((d) => d.relPath),
        ['a.md', 'b.md', 'c.md']
      );
    });

    it('calls onParsed exactly once per file, reaching the full count', async () => {
      const baseDir = tmpTree();
      for (let i = 0; i < 6; i++) writeNote(baseDir, `n${i}.md`);
      const files = listFiles(cfg, baseDir);
      const ticks: number[] = [];

      await reparseFiles(files, [], cfg, new Set(), (done) => ticks.push(done), { threshold: 0, maxWorkers: 2 });

      assert.equal(ticks.length, files.length);
      assert.deepEqual(
        [...ticks].sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6]
      );
    });

    // 60 files with one deliberately huge first file: it is dispatched first and finishes last, so
    // completion order cannot be file order. A unique frontmatter key per file makes newColumns a direct readout of collection order -- collect-as-complete scrambles it.
    it('preserves file order when completion order cannot be file order', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'f00.md', { frontmatter: { k00: 1 }, body: 'word '.repeat(200_000) });
      for (let i = 1; i < 60; i++) writeNote(baseDir, `f${String(i).padStart(2, '0')}.md`, { frontmatter: { [`k${String(i).padStart(2, '0')}`]: 1 } });
      const files = listFiles(cfg, baseDir);

      const result = await reparseFiles(files, [], cfg, new Set(), undefined, { threshold: 0, maxWorkers: 4 });

      assert.deepEqual(
        result.docs.map((d) => d.relPath),
        files.map((f) => f.relPath)
      );
      assert.deepEqual(
        result.newColumns,
        files.map((f) => `k${f.relPath.slice(1, 3)}`)
      );
    });

    // The pooled path cannot send a Feature across the thread boundary, so it sends the names and
    // re-resolves them: a subset that came back as "every active feature" would write rows no caller asked for.
    it('honors the caller feature selection, matching what the serial path extracts', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'a.md', { body: '# H\n\n[[b]] #tag' });
      const files = listFiles(cfg, baseDir);
      const subset = FEATURES.filter((feature) => feature.name === 'tags');

      const serial = await reparseFiles(files, subset, cfg, new Set());
      const pooled = await reparseFiles(files, subset, cfg, new Set(), undefined, { threshold: 0, maxWorkers: 2 });

      assert.deepEqual(pooled.docs[0].extracted, { tags: ['tag'] });
      assert.deepEqual(pooled.docs[0].extracted, serial.docs[0].extracted);
    });

    it('releases every worker handle when a dispatch fails, not only when it succeeds', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'gone.md');
      const files = listFiles(cfg, baseDir);
      const { rmSync } = await import('node:fs');
      rmSync(files[0].absPath);
      const baseline = liveWorkerHandles();

      await assert.rejects(reparseFiles(files, [], cfg, new Set(), undefined, { threshold: 0, maxWorkers: 2 }));

      assert.equal(liveWorkerHandles(), baseline, 'pool still holds worker handles after a failed dispatch');
    });

    it('does not accumulate worker handles across repeated dispatches', async () => {
      const baseDir = tmpTree();
      for (let i = 0; i < 4; i++) writeNote(baseDir, `n${i}.md`);
      const files = listFiles(cfg, baseDir);
      const baseline = liveWorkerHandles();

      for (let run = 0; run < 5; run++) await reparseFiles(files, [], cfg, new Set(), undefined, { threshold: 0, maxWorkers: 2 });

      assert.equal(liveWorkerHandles(), baseline, 'worker handles accumulated across dispatches');
    });

    it('a file that vanishes before the worker reads it rejects reparseFiles with the fs error, not a SenseError', async () => {
      const baseDir = tmpTree();
      writeNote(baseDir, 'gone.md');
      const files = listFiles(cfg, baseDir);
      const { rmSync } = await import('node:fs');
      rmSync(files[0].absPath);

      await assert.rejects(reparseFiles(files, [], cfg, new Set(), undefined, { threshold: 0, maxWorkers: 1 }), (err: Error) => {
        assert.ok(!(err instanceof SenseError));
        assert.match(err.message, /ENOENT/);
        return true;
      });
    });
  });
});

describe('worker error serialization (worker-error.ts)', () => {
  it('round-trips a SenseError: code and message survive, and the revived error is a real SenseError', () => {
    const original = new SenseError('COLUMN_LIMIT', 'too many columns');
    const revived = reviveError(serializeError(original));

    assert.ok(revived instanceof SenseError);
    assert.equal((revived as SenseError).code, 'COLUMN_LIMIT');
    assert.equal(revived.message, 'too many columns');
    assert.equal(revived.stack, original.stack);
  });

  it('a plain Error (e.g. a filesystem error) revives as a plain Error, not a SenseError', () => {
    const original = new Error('ENOENT: no such file');
    const revived = reviveError(serializeError(original));

    assert.ok(!(revived instanceof SenseError));
    assert.equal(revived.message, 'ENOENT: no such file');
  });

  it('a non-Error throw (e.g. a string) still serializes to a revivable payload', () => {
    const revived = reviveError(serializeError('plain string throw'));
    assert.equal(revived.message, 'plain string throw');
  });
});
