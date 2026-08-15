import assert from 'assert';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

// Fix F: busy_timeout derives from what reconcile has observed itself take, not a
// constant. See src/db.ts (reconcile's meta.reconcile_max_ms bookkeeping, open()'s derivation).

describe('derived busy_timeout', () => {
  it('a reconcile that does work records its duration in meta.reconcile_max_ms', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { db } = openTree(baseDir);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'reconcile_max_ms'`).get() as { value: string } | undefined;
    assert.ok(row, 'expected reconcile_max_ms to be recorded after a reconcile that parsed a file');
    assert.ok(Number(row?.value) >= 0);
    db.close();
  });

  it('a fabricated large reconcile_max_ms makes the next open derive a 3x busy_timeout', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const first = openTree(baseDir);
    first.db.close();

    // reopen with nothing changed (fast no-op reconcile, doesn't touch meta itself) and fabricate a huge recorded max
    const probe = openTree(baseDir);
    probe.db.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '50000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    probe.db.close();

    const second = openTree(baseDir);
    const timeout = (second.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    assert.equal(timeout, 150000, '3x the fabricated 50000ms max');
    second.db.close();
  });

  it('one pathological recorded max is capped at 10 minutes, not honoured forever', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });
    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    // an 8-minute build would derive 24min; the cap keeps later opens bounded
    probe.db.prepare(`INSERT INTO meta (key, value) VALUES ('reconcile_max_ms', '480000') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    probe.db.close();

    const second = openTree(baseDir);
    const timeout = (second.db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    assert.equal(timeout, 600000);
    second.db.close();
  });

  it('a small or absent recorded max stays at the 30s floor', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'body' });

    const { db } = openTree(baseDir);
    const timeout = (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;
    assert.equal(timeout, 30000);
    db.close();
  });
});
