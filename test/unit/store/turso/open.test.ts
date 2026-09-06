import assert from 'node:assert';
import { statSync } from 'node:fs';
import { join } from 'node:path';
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

  it('a feature-toggle config change narrows to the toggled feature instead of erroring or reparsing the tree', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await tursoTree(baseDir);
    await first.store.close();
    const second = await openConfig({ store: 'turso', presets: { default: { include: ['**/*.md'] } }, features: { tags: false }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
    assert.equal(second.parsed, 0);
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

  // The client leaves the WAL for the next opener, so without a checkpoint on close a tree
  // reconciled repeatedly grows one without bound (PLAN 3.36 I).
  it('close() checkpoints the WAL away instead of leaving it for the next open', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' }, body: 'body' });
    const wal = join(baseDir, '.sense', 'cache.turso.db-wal');

    for (let i = 0; i < 3; i++) {
      const { store } = await tursoTree(baseDir);
      writeNote(baseDir, `n${i}.md`, { frontmatter: { title: `N${i}` }, body: 'body '.repeat(200) });
      await store.close();
      assert.equal(statSync(wal, { throwIfNoEntry: false })?.size ?? 0, 0, `WAL left behind after close ${i}`);
    }
  });
});

// store.ts's close() reclaims turso#8170's FTS space amplification (PLAN 3.41) once the cache
// file outgrows its recorded compact size by the bloat factor, re-recording the size (PLAN 3.52).
describe('cache bloat reclaim', () => {
  const dbSize = (baseDir: string) => statSync(join(baseDir, '.sense', 'cache.turso.db')).size;

  // A quiet open/close that only reads meta: at rest the file is within the guarantee, so the
  // probe reclaims nothing and perturbs nothing.
  async function compactSize(baseDir: string): Promise<number> {
    const probe = await tursoTree(baseDir);
    const row = (await (await probe.store.prepare(`SELECT value FROM meta WHERE key = 'compact_size'`)).get()) as { value: string } | undefined;
    await probe.store.close();
    return Number(row?.value ?? '0');
  }

  function seed(baseDir: string, tag: string, count: number, repeats: number) {
    for (let i = 0; i < count; i++) writeNote(baseDir, `n${String(i).padStart(3, '0')}.md`, { frontmatter: { title: `N${i}` }, body: `${tag} body `.repeat(repeats) });
  }

  it('bloat under the factor accumulates without reclaiming', async () => {
    const baseDir = tmpTree();
    seed(baseDir, 'seed', 200, 25);
    const first = await tursoTree(baseDir);
    await first.store.close();
    const baseline = dbSize(baseDir);
    const base = await compactSize(baseDir);
    assert.ok(base > 0, 'the cold close must have recorded the compact baseline');

    seed(baseDir, 'c1', 50, 20); // 50 rewrites: FTS garbage, far under the factor
    const { store } = await tursoTree(baseDir);
    await store.close();
    const after = dbSize(baseDir);
    assert.ok(after > baseline, 'the rewrites must leave FTS garbage behind');
    assert.ok(after <= 1.5 * base, 'no reclaim below the factor');
    assert.equal(await compactSize(baseDir), base, 'the baseline is untouched under the factor');
  });

  it('crossing the factor reclaims once, re-records the size, and rests within the guarantee', async () => {
    const baseDir = tmpTree();
    seed(baseDir, 'seed', 200, 25);
    const first = await tursoTree(baseDir);
    await first.store.close();

    let prev = dbSize(baseDir);
    let peak = prev;
    let crossed = false;
    for (let k = 1; k <= 20 && !crossed; k++) {
      seed(baseDir, `c${k}`, 50, 20 + k); // body length grows with k, so every rewrite reparses
      const { store } = await tursoTree(baseDir);
      await store.close();
      const now = dbSize(baseDir);
      if (now > peak) peak = now;
      if (now < prev) crossed = true; // a shrink is only VACUUM: reparsing never shrinks the file
      prev = now;
    }
    assert.ok(crossed, 'bloat must cross the factor within 20 cycles');
    const newBase = await compactSize(baseDir);
    assert.ok(newBase < peak, 'the baseline is re-recorded at the post-VACUUM size, not the bloated peak');
    assert.ok(dbSize(baseDir) <= 1.5 * newBase, 'the file rests within the guarantee of its re-recorded baseline');
  });

  it('a cold build never reclaims and records the built size as its baseline', async () => {
    const baseDir = tmpTree();
    seed(baseDir, 'seed', 200, 25);
    const { store } = await tursoTree(baseDir);
    // A cold-build VACUUM is size-invisible (a fresh file has no garbage), so no-reclaim is
    // structural: only close() may write the baseline the reclaim branch requires.
    const early = (await (await store.prepare(`SELECT value FROM meta WHERE key = 'compact_size'`)).get()) as { value: string } | undefined;
    assert.equal(early, undefined, 'nothing may record the baseline during the cold reconcile');
    await store.close();
    const base = await compactSize(baseDir);
    assert.ok(base > 0, 'the cold close must have recorded a baseline');
    const built = dbSize(baseDir);
    assert.ok(built >= base && built - base <= 16384, 'only the baseline row itself may follow the recorded size');
  });
});
