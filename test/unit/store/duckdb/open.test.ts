import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { search } from 'sensemaking';
import { STORE_DIMS } from '../../../../src/embed/types.ts';
import { duckdbOpenDialect } from '../../../../src/store/duckdb/open.ts';
import { writeModel } from '../../../lib/model.ts';
import { NOT_LOCKED_MESSAGES } from '../../../lib/stores.ts';
import { openConfig, packageRoot, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string, presets?: Record<string, unknown>) {
  return openConfig({ store: 'duckdb', presets: presets ?? { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('openDuckdb', () => {
  it('opens a real temp tree, reconciles, and reports docCount through the portable surface', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const result = await duckdbTree(baseDir);
    assert.equal(result.store.name, 'duckdb');
    assert.equal(result.parsed, 2);
    assert.equal(result.dbPath, join(baseDir, '.sense', 'cache.duckdb'));
    const stmt = await result.store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
    assert.equal(((await stmt.get()) as { n: bigint | number }).n, BigInt(2));
    await result.store.close();
  });

  it('a second open on an unchanged tree reparses nothing', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();
    const second = await duckdbTree(baseDir);
    assert.equal(second.parsed, 0);
    await second.store.close();
  });

  it('repeated open/close with a write between iterations does not corrupt the cache', async () => {
    // Without the instance's closeSync() on store.close(), the WAL is never checkpointed and
    // a later open fails with "the WAL checkpoint iteration does not match".
    const baseDir = tmpTree();
    for (let i = 0; i < 100; i++) writeNote(baseDir, `d/note-${String(i).padStart(4, '0')}.md`, { frontmatter: { title: `Note ${i}` } });
    for (let i = 0; i < 8; i++) {
      const result = await duckdbTree(baseDir);
      assert.equal(result.parsed, i === 0 ? 100 : 1);
      await result.store.close();
      writeNote(baseDir, 'd/note-0000.md', { frontmatter: { title: 'Note 0' }, body: `body edit ${i}` });
    }
  });

  it('recreates vector staging after reopen and preserves earlier vectors', async () => {
    const baseDir = tmpTree();
    const embed = {
      model: writeModel([
        ['apple', 'pomme'],
        ['stone', 'rock'],
      ]),
      provider: 'static' as const,
    };
    const open = () => openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, embed, queries: {}, baseDir, configPath: null });
    const appleVector = new Array<number>(STORE_DIMS).fill(0);
    appleVector[0] = 1;
    const stoneVector = new Array<number>(STORE_DIMS).fill(0);
    stoneVector[1] = 1;

    writeNote(baseDir, 'a.md', { body: 'apple' });
    const first = await open();
    try {
      const firstHits = await search(first.store, first.cfg, 'pomme');
      assert.deepEqual(
        firstHits.map(({ path, via, similarity }) => ({ path, via, similarity })),
        [{ path: 'a.md', via: 'vector', similarity: 1 }]
      );
      assert.deepEqual(await (await first.store.prepare('SELECT vector FROM embeddings WHERE "path" = ? AND chunk = 0')).get('a.md'), { vector: appleVector });
    } finally {
      await first.store.close();
    }

    writeNote(baseDir, 'b.md', { body: 'stone' });
    const reopened = await open();
    try {
      const reopenedHits = await search(reopened.store, reopened.cfg, 'rock');
      assert.deepEqual(
        reopenedHits.map(({ path, via, similarity }) => ({ path, via, similarity })),
        [
          { path: 'b.md', via: 'vector', similarity: 1 },
          { path: 'a.md', via: 'vector', similarity: 0 },
        ]
      );
      assert.deepEqual(await (await reopened.store.prepare('SELECT "path", chunk, vector FROM embeddings ORDER BY "path", chunk')).all(), [
        { path: 'a.md', chunk: 0, vector: appleVector },
        { path: 'b.md', chunk: 0, vector: stoneVector },
      ]);
    } finally {
      await reopened.store.close();
    }
  });

  it('a feature-toggle config change narrows to the toggled feature instead of erroring or reparsing the tree', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();
    const second = await openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, features: { tags: false }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
    assert.equal(second.parsed, 0);
    await second.store.close();
  });
});

// isLocked decides whether connectUnlocked retries or gives up. The Windows phrasing is absent from every
// posix run, so a posix-only matcher passes locally and fails on Windows CI. Verbatim engine messages.
describe('duckdb isLocked', () => {
  const LOCKED = [
    ['posix', 'IO Error: Could not set lock on file "/tmp/t/.sense/cache.duckdb": Conflicting lock is held in /usr/bin/node (PID 4242)'],
    ['windows', 'IO Error: Cannot open file "C:\\t\\.sense\\cache.duckdb": The process cannot access the file because it is being used by another process. File is already open in C:\\hostedtoolcache\\windows\\node\\26.8.1\\x64\\node.exe (PID 8792)'],
  ] as const;
  for (const [platform, message] of LOCKED) {
    it(`recognises its ${platform} lock message`, () => {
      assert.ok(duckdbOpenDialect.isLocked?.(new Error(message)), `duckdb must retry on: ${message}`);
    });
  }
  for (const message of NOT_LOCKED_MESSAGES) {
    it(`does not read "${message.slice(0, 40)}..." as a lock`, () => {
      assert.equal(duckdbOpenDialect.isLocked?.(new Error(message)), false, `duckdb must fail fast on: ${message}`);
    });
  }
});

describe('duckdb engine', () => {
  it('records the installed package as its engine identity', async () => {
    const installed = (JSON.parse(readFileSync(join(packageRoot, 'node_modules', '@duckdb/node-api', 'package.json'), 'utf8')) as { version: string }).version;
    assert.equal(await duckdbOpenDialect.engineIdentity?.(), `@duckdb/node-api@${installed}`);
  });

  it('passes the shared behaviour check on the installed engine', async () => {
    await duckdbOpenDialect.checkEngine?.();
  });
});
