import assert from 'node:assert';
import { rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCache, mapTree, open, SenseError } from 'sensemaking';
import { scratchDir } from '../../../lib/scratch.ts';
import { openTree, tmpTree, writeNote } from '../../../lib/tree.ts';

function tmpReconcileTree(): string {
  return scratchDir('reconcile');
}

function write(baseDir: string, relPath: string, frontmatter: Record<string, unknown>): void {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  writeFileSync(join(baseDir, relPath), `---\n${lines.join('\n')}\n---\n\nbody\n`);
}

function openReconcileTree(baseDir: string) {
  return open({ presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null });
}

describe('reconcile', () => {
  it('create files -> open -> counts', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const result = await openReconcileTree(baseDir);
    const rows = (await (await result.store.prepare('SELECT path FROM frontmatter ORDER BY path')).all()) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(result.parsed, 2);
  });

  it('unchanged files are not reparsed on a second open', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = await openReconcileTree(baseDir);
    assert.equal(first.parsed, 1);
    await first.store.close();

    const second = await openReconcileTree(baseDir);
    assert.equal(second.parsed, 0, 'warm cache: nothing should be reparsed');
    await second.store.close();
  });

  it('modifying a file (mtime/size change) updates its row', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'Original' });

    const first = await openReconcileTree(baseDir);
    await first.store.close();

    // force a distinct mtime; fast successive writes can quantize to the same one
    write(baseDir, 'a.md', { title: 'Updated', extra: 'field' });
    const future = new Date(Date.now() + 5000);
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = await openReconcileTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = (await (await second.store.prepare('SELECT title, extra FROM frontmatter WHERE path = ?')).get('a.md')) as Record<string, unknown>;
    assert.equal(row.title, 'Updated');
    assert.equal(row.extra, 'field');
    await second.store.close();
  });

  it('deleting a file removes its row', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'b.md', { title: 'B' });

    const first = await openReconcileTree(baseDir);
    await first.store.close();

    rmSync(join(baseDir, 'b.md'));

    const second = await openReconcileTree(baseDir);
    const rows = (await (await second.store.prepare('SELECT path FROM frontmatter ORDER BY path')).all()) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md']
    );
    await second.store.close();
  });

  it('adding a file makes its row appear', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = await openReconcileTree(baseDir);
    await first.store.close();

    write(baseDir, 'b.md', { title: 'B' });

    const second = await openReconcileTree(baseDir);
    const rows = (await (await second.store.prepare('SELECT path FROM frontmatter ORDER BY path')).all()) as Array<{ path: string }>;
    assert.deepEqual(
      rows.map((r) => r.path),
      ['a.md', 'b.md']
    );
    assert.equal(second.parsed, 1, 'only the new file should be reparsed');
    await second.store.close();
  });

  it('a new frontmatter key adds a column', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = await openReconcileTree(baseDir);
    await first.store.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'b.md', { title: 'B', brandNew: 'yes' });
    utimesSync(join(baseDir, 'b.md'), future, future);

    const second = await openReconcileTree(baseDir);
    const columns = await second.store.docs.columns();
    assert.ok(columns.includes('brandNew'));

    const rowA = (await (await second.store.prepare('SELECT brandNew FROM frontmatter WHERE path = ?')).get('a.md')) as Record<string, unknown>;
    assert.equal(rowA.brandNew, null, 'pre-existing rows get NULL for a newly added column');
    await second.store.close();
  });

  it('clearCache: deletes .sense/, so the next open fully re-crawls and drops lingering columns', async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });
    write(baseDir, 'gone.md', { title: 'Gone', ephemeral: 'value' });

    const first = await openReconcileTree(baseDir);
    let columns = await first.store.docs.columns();
    assert.ok(columns.includes('ephemeral'));
    await first.store.close();

    rmSync(join(baseDir, 'gone.md'));
    const second = await openReconcileTree(baseDir);
    // ALTER TABLE ADD COLUMN doesn't undo itself
    columns = await second.store.docs.columns();
    assert.ok(columns.includes('ephemeral'), 'column lingers after the row is deleted');
    await second.store.close();

    const cfg = { presets: { default: { include: ['*.md'] } }, queries: {}, baseDir, configPath: null };
    clearCache(cfg);
    const rebuilt = await open(cfg);
    columns = await rebuilt.store.docs.columns();
    assert.ok(!columns.includes('ephemeral'), 'a cleared cache re-crawls fresh, dropping the lingering column');
    const count = ((await (await rebuilt.store.prepare('SELECT COUNT(*) AS n FROM frontmatter')).get()) as { n: number }).n;
    assert.equal(count, 1);
    await rebuilt.store.close();
  });

  it('re-parsing an existing doc leaves exactly one content row per path, and search finds the updated text', async () => {
    const baseDir = tmpReconcileTree();
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\noriginal needle text\n');

    const first = await openReconcileTree(baseDir);
    await first.store.close();

    const future = new Date(Date.now() + 5000);
    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A"\n---\n\nupdated haystack text\n');
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = await openReconcileTree(baseDir);
    const count = ((await (await second.store.prepare('SELECT COUNT(*) AS n FROM content WHERE "path" = ?')).get('a.md')) as { n: number }).n;
    assert.equal(count, 1, 'exactly one content row per path after a reparse');

    const hit = ((await (await second.store.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?')).get('haystack')) as { n: number }).n;
    assert.equal(hit, 1);
    const stale = ((await (await second.store.prepare('SELECT COUNT(*) AS n FROM content WHERE content MATCH ?')).get('needle')) as { n: number }).n;
    assert.equal(stale, 0, 'the old text should no longer be indexed');
    await second.store.close();
  });

  it("the frontmatter upsert keeps a row's rowid stable across a reparse, so content stays coupled to it", async () => {
    const baseDir = tmpReconcileTree();
    write(baseDir, 'a.md', { title: 'A' });

    const first = await openReconcileTree(baseDir);
    const before = ((await (await first.store.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?')).get('a.md')) as { r: number }).r;
    await first.store.close();

    const future = new Date(Date.now() + 5000);
    write(baseDir, 'a.md', { title: 'A2' });
    utimesSync(join(baseDir, 'a.md'), future, future);

    const second = await openReconcileTree(baseDir);
    const after = ((await (await second.store.prepare('SELECT rowid AS r FROM frontmatter WHERE "path" = ?')).get('a.md')) as { r: number }).r;
    assert.equal(after, before, 'ON CONFLICT UPDATE should not change the rowid the way OR REPLACE would');
    await second.store.close();
  });

  it("crossing SQLite's column limit fails with a named error, not the raw SQLite message", async () => {
    const baseDir = tmpReconcileTree();
    const frontmatter: Record<string, unknown> = {};
    for (let i = 0; i < 2001; i++) frontmatter[`k${i}`] = i;
    write(baseDir, 'huge.md', frontmatter);

    await assert.rejects(openReconcileTree(baseDir), (err: unknown) => {
      assert.ok(err instanceof SenseError, `expected a SenseError, got ${err}`);
      assert.equal((err as SenseError).code, 'COLUMN_LIMIT');
      assert.match((err as Error).message, /2000/);
      assert.match((err as Error).message, /sqlite\.org\/limits\.html/);
      assert.match((err as Error).message, /presets.+include/);
      return true;
    });
  });
});

describe('_ctime core column', () => {
  it('every row carries the file birthtime, and the key is reserved', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, warnings } = await openTree(baseDir);
    const row = (await (await store.prepare(`SELECT "_ctime", "_mtime" FROM frontmatter WHERE "path" = 'a.md'`)).get()) as { _ctime: number; _mtime: number };
    assert.equal(typeof row._ctime, 'number');
    assert.ok(row._ctime > 0 && row._ctime <= row._mtime, 'birthtime precedes or equals mtime');
    await store.close();

    // Reserved: an author-written _ctime is dropped with a warning, not stored.
    writeNote(baseDir, 'b.md', { frontmatter: '_ctime: 123' });
    const second = await openTree(baseDir);
    const b = (await (await second.store.prepare(`SELECT "_ctime" FROM frontmatter WHERE "path" = 'b.md'`)).get()) as { _ctime: number };
    assert.notEqual(b._ctime, 123);
    assert.ok([...warnings, ...second.warnings].every((w) => typeof w === 'string'));
    await second.store.close();
  });

  it('map does not list _ctime as a frontmatter field', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg } = await openTree(baseDir);
    const result = await mapTree(store, cfg);
    const fields = result.fields.map((f) => f.field);
    assert.ok(!fields.includes('_ctime'), `internal column leaked: ${fields.join(', ')}`);
    await store.close();
  });
});
