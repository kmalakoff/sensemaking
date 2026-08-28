import assert from 'node:assert';
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

const write = (baseDir: string, relPath: string, body: string, frontmatter: Record<string, unknown> = {}) => writeNote(baseDir, relPath, { body, frontmatter });

describe('rank feature', () => {
  it('a heavily linked note outranks a leaf', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'the center');
    write(baseDir, 'a.md', 'points at [[hub]]');
    write(baseDir, 'b.md', 'points at [[hub]]');
    write(baseDir, 'c.md', 'points at [[hub]] and [[a]]');

    const { db } = openTree(baseDir);
    const rows = db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC').all() as Array<{ path: string; _rank: number }>;
    assert.equal(rows[0].path, 'hub.md');
    assert.ok(rows[0]._rank > rows[rows.length - 1]._rank);
  });

  it('rank recomputes when links change', () => {
    const baseDir = tmpTree();
    write(baseDir, 'a.md', 'no links yet');
    write(baseDir, 'b.md', 'none here either');

    const first = openTree(baseDir);
    first.db.close();

    write(baseDir, 'a.md', 'now points at [[b]], twice: [[b]]');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const rows = second.db.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "_rank" DESC').all() as Array<{ path: string }>;
    assert.equal(rows[0].path, 'b.md');
    second.db.close();
  });

  it('recompute is skipped when the reconcile touched no link rows', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'first body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    // plant an otherwise-impossible rank value; a recompute would overwrite it with the real one
    const probe = openTree(baseDir); // nothing changed since `first` -> no-op reconcile, no afterReconcile call
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    // hub.md has no outbound links, so reparsing it touches no link rows
    const future = new Date(Date.now() + 5000);
    write(baseDir, 'hub.md', 'second body, still no links');
    utimesSync(join(baseDir, 'hub.md'), future, future);

    const second = openTree(baseDir);
    const row = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    assert.equal(row._rank, 999, 'rank recompute should have been skipped, leaving the planted value in place');
    second.db.close();
  });

  it('a touch-only reparse of a linked note keeps dst and skips the rank recompute', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    // same content, newer mtime: the links are re-stored but no edge changed
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    const link = second.db.prepare('SELECT dst FROM links WHERE src = ?').get('a.md') as { dst: string | null };
    assert.equal(hub._rank, 999, 'no edge changed, so the recompute must be skipped');
    assert.equal(link.dst, 'hub.md', 'the preserved row must keep its resolved dst');
    second.db.close();
  });

  it('adding a linkless note recomputes: the node set changed even though no edge did', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    write(baseDir, 'newcomer.md', 'no links here, none point at me');

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    const fresh = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('newcomer.md') as { _rank: number | null };
    assert.notEqual(hub._rank, 999, 'the planted value should have been overwritten by a recompute');
    assert.ok(fresh._rank !== null, 'the new note must get a rank, not stay NULL');
    second.db.close();
  });

  it('reparsing a note down to zero links recomputes: its old rows carried edges', () => {
    const baseDir = tmpTree();
    write(baseDir, 'hub.md', 'body');
    write(baseDir, 'a.md', 'points at [[hub]]');

    const first = openTree(baseDir);
    first.db.close();

    const probe = openTree(baseDir);
    probe.db.prepare('UPDATE frontmatter SET "_rank" = ? WHERE "path" = ?').run(999, 'hub.md');
    probe.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', 'the link is gone now');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openTree(baseDir);
    const hub = second.db.prepare('SELECT "_rank" FROM frontmatter WHERE "path" = ?').get('hub.md') as { _rank: number };
    assert.notEqual(hub._rank, 999, 'losing the last inbound edge must trigger a recompute');
    second.db.close();
  });
});
