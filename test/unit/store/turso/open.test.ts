import assert from 'node:assert';
import { join } from 'node:path';
import { tursoOpenDialect } from '../../../../src/store/turso/open.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function tursoTree(baseDir: string, presets?: Record<string, unknown>) {
  return openConfig({ store: 'turso', presets: presets ?? { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

describe('openTurso', () => {
  it('opens a real temp tree, reconciles, and reports docCount through the portable surface', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const result = await tursoTree(baseDir);
    assert.equal(result.store.name, 'turso');
    assert.equal(result.parsed, 2);
    assert.equal(result.dbPath, join(baseDir, '.sense', 'cache.turso.db'));
    const stmt = await result.store.prepare('SELECT COUNT(*) AS n FROM frontmatter');
    assert.equal(((await stmt.get()) as { n: number }).n, 2);
    await result.store.close();
  });

  it('a second open on an unchanged tree reparses nothing', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await tursoTree(baseDir);
    await first.store.close();
    const second = await tursoTree(baseDir);
    assert.equal(second.parsed, 0);
    await second.store.close();
  });

  it('repeated open/close with a write between iterations does not corrupt the cache', async () => {
    // Without a proper close(), a WAL-based engine can leave the file in a state the next open
    // can't reconcile against -- the same risk duckdb's own equivalent test guards.
    const baseDir = tmpTree();
    for (let i = 0; i < 20; i++) writeNote(baseDir, `d/note-${String(i).padStart(4, '0')}.md`, { frontmatter: { title: `Note ${i}` } });
    for (let i = 0; i < 5; i++) {
      const result = await tursoTree(baseDir);
      assert.equal(result.parsed, i === 0 ? 20 : 1);
      await result.store.close();
      writeNote(baseDir, 'd/note-0000.md', { frontmatter: { title: 'Note 0' }, body: `body edit ${i}` });
    }
  });

  it('a feature-toggle config change rebuilds the cache rather than erroring', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await tursoTree(baseDir);
    await first.store.close();
    const second = await openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, features: { tags: false }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
    assert.equal(second.parsed, 1);
    await second.store.close();
  });
});

// See src/store/turso/reconcile.ts (meta.reconcile_max_ms bookkeeping, forked from sqlite's) and
// src/store/turso/open.ts (derivation, installed via a runtime PRAGMA before reconcile).
describe('derived busy_timeout', () => {
  it('a reconcile that does work records its duration in meta.reconcile_max_ms', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { store } = await tursoTree(baseDir);
    const row = (await (await store.prepare(`SELECT value FROM meta WHERE key = 'reconcile_max_ms'`)).get()) as { value: string } | undefined;
    assert.ok(row, 'expected reconcile_max_ms to be recorded after a reconcile that parsed a file');
    assert.ok(Number(row?.value) >= 0);
    await store.close();
  });

  it('a fabricated large reconcile_max_ms makes the next open derive a 3x busy_timeout', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const first = await tursoTree(baseDir);
    await first.store.close();

    const probe = await tursoTree(baseDir);
    const insertMax = await probe.store.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '50000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await insertMax.run();
    await probe.store.close();

    const second = await tursoTree(baseDir);
    const timeout = ((await (await second.store.prepare('PRAGMA busy_timeout')).get()) as { busy_timeout: number }).busy_timeout;
    assert.equal(timeout, 150000, '3x the fabricated 50000ms max');
    await second.store.close();
  });

  it('one pathological recorded max is capped at 10 minutes, not honoured forever', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });
    const first = await tursoTree(baseDir);
    await first.store.close();

    const probe = await tursoTree(baseDir);
    const insertMax = await probe.store.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '480000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    await insertMax.run();
    await probe.store.close();

    const second = await tursoTree(baseDir);
    const timeout = ((await (await second.store.prepare('PRAGMA busy_timeout')).get()) as { busy_timeout: number }).busy_timeout;
    assert.equal(timeout, 600000);
    await second.store.close();
  });

  it('a small or absent recorded max stays at the 30s floor', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { store } = await tursoTree(baseDir);
    const timeout = ((await (await store.prepare('PRAGMA busy_timeout')).get()) as { busy_timeout: number }).busy_timeout;
    assert.equal(timeout, 30000);
    await store.close();
  });
});

// Recorded from real concurrent opens. Only the "Failed locking file" prefix is common to both
// platforms; what follows it differs, which is why the match is on the prefix.
describe('turso isLocked', () => {
  const held = [
    ['posix', 'store "turso" failed to open /t/.sense/cache.turso.db: failed to open database /t/.sense/cache.turso.db: Locking error: Failed locking file \'/t/.sense/cache.turso.db\'. File is locked by another process'],
    ['windows', 'store "turso" failed to open D:\\t\\cache.turso.db: failed to open database D:\\t\\cache.turso.db: Locking error: Failed locking file, The process cannot access the file because it is being used by another process.'],
  ] as const;
  for (const [platform, message] of held) {
    it(`treats the ${platform} held-lock wording as retryable`, () => {
      assert.equal(tursoOpenDialect.isLocked?.(new Error(message)), true);
    });
  }

  it('leaves an error that is not a held lock alone', () => {
    assert.equal(tursoOpenDialect.isLocked?.(new Error('failed to open database /t/x.db: no such file')), false);
  });
});
