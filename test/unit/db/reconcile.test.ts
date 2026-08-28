import assert from 'node:assert';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, open, SenseError } from 'sensemaking';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

function tmpReconcileTree(): string {
  return mkdtempSync(join(tmpdir(), 'sense-reconcile-'));
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\nbody\n`);
}

function openReconcileTree(baseDir: string) {
  return open({ presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null });
}

describe('reconcile', () => {
  it('create files -> open -> counts', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const result = openReconcileTree(baseDir);
    const rows = result.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(result.parsed, 2);
  });

  it('unchanged files are not reparsed on a second open', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openReconcileTree(baseDir);
    assert.equal(first.parsed, 1);
    first.db.close();

    const second = openReconcileTree(baseDir);
    assert.equal(second.parsed, 0, 'warm cache: nothing should be reparsed');
    second.db.close();
  });

  it('modifying a file (mtime/size change) updates its row', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'Original' });

    const first = openReconcileTree(baseDir);
    first.db.close();

    // force a distinct mtime; fast successive writes can quantize to the same one
    write(baseDir, 'a.md', { title: 'Updated', extra: 'field' });
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openReconcileTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = second.db.prepare('SELECT title, extra FROM frontmatter WHERE path = ?').get('a.md') as Record<string, unknown>;
    assert.equal(row.title, 'Updated');
    assert.equal(row.extra, 'field');
    second.db.close();
  });

  it('deleting a file removes its row', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const first = openReconcileTree(baseDir);
    first.db.close();

    rmSync(join(baseDir, 'b.md'));

    const second = openReconcileTree(baseDir);
    const rows = second.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
    second.db.close();
  });

  it('adding a file makes its row appear', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openReconcileTree(baseDir);
    first.db.close();

    write(baseDir, 'b.md', { title: 'B' });

    const second = openReconcileTree(baseDir);
    const rows = second.db.prepare('SELECT path FROM frontmatter ORDER BY path').all() as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(second.parsed, 1, 'only the new file should be reparsed');
    second.db.close();
  });

  it('a new frontmatter key adds a column', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openReconcileTree(baseDir);
    first.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'b.md', { title: 'B', brandNew: 'yes' });
    utimesSync(join(baseDir, 'b.md'), future, future);

    const second = openReconcileTree(baseDir);
    const columns = second.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(columns.some((c) => c.name === 'brandNew'));

    const rowA = second.db.prepare('SELECT brandNew FROM frontmatter WHERE path = ?').get('a.md') as Record<string, unknown>;
    assert.equal(rowA.brandNew, null, 'pre-existing rows get NULL for a newly added column');
    second.db.close();
  });

  it('clearCache: deletes .sense/, so the next open fully re-crawls and drops lingering columns', () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'gone.md', { title: 'Gone', ephemeral: 'value' });

    const first = openReconcileTree(baseDir);
    let columns = first.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(columns.some((c) => c.name === 'ephemeral'));
    first.db.close();

    rmSync(join(baseDir, 'gone.md'));
    const second = openReconcileTree(baseDir);
    // ALTER TABLE ADD COLUMN doesn't undo itself
    columns = second.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(
      columns.some((c) => c.name === 'ephemeral'),
      'column lingers after the row is deleted'
    );
    second.db.close();

    const cfg = { presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null };
    clearCache(cfg);
    const rebuilt = open(cfg);
    columns = rebuilt.db.prepare('PRAGMA table_info(frontmatter)').all() as Array<{ name: string }>;
    assert.ok(!columns.some((c) => c.name === 'ephemeral'), 'a cleared cache re-crawls fresh, dropping the lingering column');
    const count = (rebuilt.db.prepare('SELECT COUNT(*) AS n FROM frontmatter').get() as { n: number }).n;
    assert.equal(count, 1);
    rebuilt.db.close();
  });

  it('re-parsing an existing doc leaves exactly one content row per path, and search finds the updated text', () => {
    const baseDir = tmpReconcileTree();
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\noriginal needle text\n');

    const first = openReconcileTree(baseDir);
    first.db.close();

    const future = new Date(Date.now() + 5000);
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\nupdated haystack text\n');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openReconcileTree(baseDir);
    const count = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE "path" = ?').get('a.md') as { n: number }).n;
    assert.equal(count, 1, 'exactly one content row per path after a reparse');

    const hit = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('haystack') as { n: number }).n;
    assert.equal(hit, 1);
    const stale = (second.db.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?').get('needle') as { n: number }).n;
    assert.equal(stale, 0, 'the old text should no longer be indexed');
    second.db.close();
  });

  it("the frontmatter upsert keeps a row's rowid stable across a reparse, so content stays coupled to it", () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = openReconcileTree(baseDir);
    const before = (first.db.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?').get('a.md') as { r: number }).r;
    first.db.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', { title: 'A2' });
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = openReconcileTree(baseDir);
    const after = (second.db.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?').get('a.md') as { r: number }).r;
    assert.equal(after, before, 'ON CONFLICT UPDATE should not change the rowid the way OR REPLACE would');
    second.db.close();
  });

  it("crossing SQLite's column limit fails with a named error, not the raw SQLite message", () => {
    const baseDir = tmpReconcileTree();
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) frontmatter[`k${i}`] = i;
    write(baseDir, 'huge.md', frontmatter);

    assert.throws(
      () => openReconcileTree(baseDir),
      (err: unknown) => {
        assert.ok(err instanceof SenseError, `expected a SenseError, got ${err}`);
        assert.equal((err as SenseError).code, 'COLUMN_LIMIT');
        assert.match((err as Error).message, /2000/);
        assert.match((err as Error).message, /sqlite\.org\/limits\.html/);
        assert.match((err as Error).message, /presets.+include/);
        return true;
      }
    );
  });
});

describe('_ctime core column', () => {
  it('every row carries the file birthtime, and the key is reserved', () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { db, warnings } = openTree(baseDir);
    const row = db.prepare(`SELECT "_ctime", "_mtime" FROM frontmatter WHERE "path" = 'a.md'`).get() as { _ctime: number; _mtime: number };
    assert.equal(typeof row._ctime, 'number');
    assert.ok(row._ctime > 0 && row._ctime <= row._mtime, 'birthtime precedes or equals mtime');
    db.close();

    // Reserved: an author-written _ctime is dropped with a warning, not stored.
    writeNote(baseDir, 'b.md', { frontmatter: '_ctime: 123' });
    const second = openTree(baseDir);
    const b = second.db.prepare(`SELECT "_ctime" FROM frontmatter WHERE "path" = 'b.md'`).get() as { _ctime: number };
    assert.notEqual(b._ctime, 123);
    assert.ok([...warnings, ...second.warnings].every((w) => typeof w === 'string'));
    second.db.close();
  });

  it('map does not list _ctime as a frontmatter field', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { db, cfg } = openTree(baseDir);
    const { mapTree } = await import('sensemaking');
    const fields = mapTree(db, cfg).fields.map((f) => f.field);
    assert.ok(!fields.includes('_ctime'), `internal column leaked: ${fields.join(', ')}`);
    db.close();
  });
});
