import assert from 'node:assert';
import type { Config } from 'sensemaking';
import { FEATURES } from '../../../src/features/index.ts';
import { listFiles, parseFile } from '../../../src/scan/index.ts';
import { ParsePool } from '../../../src/scan/pool.ts';
import { tmpTree, writeNote } from '../../lib/tree.ts';

const cfg: Config = { presets: { default: { include: ['**/*.md'] } }, queries: {} };

describe('ParsePool', () => {
  it('reuses an equivalent worker count and recreates the pool after a serialized count change', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < 4; i++) writeNote(baseDir, `${i}.md`);
    const files = listFiles(cfg, baseDir);

    const pool = new ParsePool();
    try {
      assert.equal(pool.poolsCreated, 0, 'a pool was constructed before the first run()');
      await pool.run(files, [], cfg, undefined, 2);
      assert.equal(pool.poolsCreated, 1, 'first run() did not construct a pool');

      await pool.run(files, [], structuredClone(cfg), undefined, 2);
      assert.equal(pool.poolsCreated, 1, 'equivalent context and worker count did not reuse the pool');

      await pool.run(files, [], cfg, undefined, 4);
      assert.equal(pool.poolsCreated, 2, 'a changed worker count did not replace the pool');

      await pool.close();
      await pool.run(files, [], cfg, undefined, 2);
      assert.equal(pool.poolsCreated, 3, 'run() after close() did not construct a fresh pool');
    } finally {
      await pool.close();
    }
  });

  it('close() before any run() is a no-op', async () => {
    const pool = new ParsePool();
    await pool.close();
  });

  it('recreates workers when feature selection changes and reuses them for equivalent context', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'authored.md', { body: 'Exact authored text #gamma #alpha/beta' });
    const files = listFiles(cfg, baseDir);
    const tags = FEATURES.filter((feature) => feature.name === 'tags');
    const pool = new ParsePool();

    try {
      const empty = await pool.run(files, [], cfg, undefined, 1);
      const tagged = await pool.run(files, tags, cfg, undefined, 1);
      const equivalent = await pool.run(files, [...tags], structuredClone(cfg), undefined, 8);

      assert.deepEqual(empty[0].doc.extracted, {});
      assert.deepEqual(tagged[0].doc.extracted, { tags: ['alpha/beta', 'gamma'] });
      assert.deepEqual(equivalent[0].doc.extracted, tagged[0].doc.extracted);
      assert.equal(pool.poolsCreated, 2, 'equivalent context did not reuse the replacement pool');
    } finally {
      await pool.close();
    }
  });

  it('captures mutable config per overlapping dispatch and drains before recreating workers', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'authored.md', { body: ['# First', 'alpha '.repeat(80), '# Second', 'beta '.repeat(80)].join('\n\n') });
    const mutable: Config = { presets: { default: { include: ['**/*.md'] } }, queries: {}, embed: { model: 'fixture', chunkTokens: 500 } };
    const files = listFiles(mutable, baseDir);
    const embed = FEATURES.filter((feature) => feature.name === 'embed');
    const original = structuredClone(mutable);
    const changed = structuredClone(mutable);
    if (!changed.embed) throw new Error('fixture embed config is missing');
    changed.embed.chunkTokens = 1;
    const originalOracle = parseFile(files[0], embed, original).doc.extracted;
    const changedOracle = parseFile(files[0], embed, changed).doc.extracted;
    assert.notDeepEqual(originalOracle, changedOracle, 'fixture config does not change authored chunks');
    const pool = new ParsePool();

    try {
      const originalDispatch = pool.run(files, embed, mutable, undefined, 1);
      if (!mutable.embed) throw new Error('fixture embed config is missing');
      mutable.embed.chunkTokens = 1;
      const changedDispatch = pool.run(files, embed, mutable, undefined, 1);
      const [originalResult, changedResult] = await Promise.all([originalDispatch, changedDispatch]);

      assert.deepEqual(originalResult[0].doc.extracted, originalOracle);
      assert.deepEqual(changedResult[0].doc.extracted, changedOracle);
      assert.equal(pool.poolsCreated, 2, 'changed config did not replace the pool');

      await pool.run(files, [...embed], structuredClone(changed), undefined, 4);
      assert.equal(pool.poolsCreated, 2, 'equivalent config did not reuse the pool');
    } finally {
      await pool.close();
    }
  });

  it('drains submitted work after a callback failure before running queued different-context work', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < 10; i++) writeNote(baseDir, `${i}.md`, { body: `Authored ${i} #tag-${i}` });
    const files = listFiles(cfg, baseDir);
    const tags = FEATURES.filter((feature) => feature.name === 'tags');
    const callbackError = new Error('callback failed');
    let completed = 0;
    const pool = new ParsePool();

    try {
      const failed = pool.run(
        files,
        [],
        cfg,
        () => {
          completed++;
          if (completed === 1) throw callbackError;
        },
        1
      );
      const queued = pool.run(files.slice(6), tags, cfg, undefined, 2);

      await assert.rejects(failed, (err) => err === callbackError);
      const queuedResult = await queued;

      assert.equal(completed, files.length, 'the failed dispatch did not drain every submitted task');
      assert.deepEqual(
        queuedResult.map((result) => result.doc.extracted),
        [{ tags: ['tag-6'] }, { tags: ['tag-7'] }, { tags: ['tag-8'] }, { tags: ['tag-9'] }]
      );
      assert.equal(pool.poolsCreated, 2, 'the queued context/count change did not replace the drained pool');
    } finally {
      await pool.close();
    }
  });
});
