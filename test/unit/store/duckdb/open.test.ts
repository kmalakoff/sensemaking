import assert from 'node:assert';
import { join } from 'node:path';
import { duckdbOpenDialect } from '../../../../src/store/duckdb/open.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

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

  it('a feature-toggle config change rebuilds the cache rather than erroring', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();
    const second = await openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, features: { tags: false }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
    assert.equal(second.parsed, 1);
    await second.store.close();
  });
});

// Recorded from real concurrent opens on each platform. The engine words one condition two ways,
// and matching only the POSIX one shipped a retry that never fired on Windows.
describe('duckdb isLocked', () => {
  const held = [
    ['posix', 'store "duckdb" failed to open /t/.sense/cache.duckdb: IO Error: Could not set lock on file "/t/.sense/cache.duckdb": Conflicting lock is held in /usr/bin/node (PID 4776) by user kevin.'],
    ['windows', 'store "duckdb" failed to open D:\\t\\.sense\\cache.duckdb: IO Error: Cannot open file "D:\\t\\.sense\\cache.duckdb": The process cannot access the file because it is being used by another process.'],
  ] as const;
  for (const [platform, message] of held) {
    it(`treats the ${platform} held-lock wording as retryable`, () => {
      assert.equal(duckdbOpenDialect.isLocked?.(new Error(message)), true);
    });
  }

  it('leaves an error that is not a held lock alone', () => {
    assert.equal(duckdbOpenDialect.isLocked?.(new Error('IO Error: Cannot open file "/t/x.duckdb": No such file or directory')), false);
  });
});
