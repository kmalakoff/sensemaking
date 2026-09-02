import { rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { SenseError } from '../../../src/errors.ts';
import { reconcile } from '../../../src/store/reconcile.ts';
import { getColumns } from '../../../src/store/shared.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { BEGIN_WRITE } from '../../../src/store/transaction.ts';
import type { Connection, ReconcileDialect } from '../../../src/store/types.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// The orchestration in src/store/reconcile.ts, parameterised by a test ReconcileDialect against
// a real sqlite-backed store. Engine-specific dialect behavior lives in each store's own reconcile.test.ts.

function baseDialect(overrides: Partial<ReconcileDialect> = {}): ReconcileDialect {
  return {
    beginMode: () => BEGIN_WRITE,
    checkColumnLimit: () => undefined,
    addColumns: async (conn, names) => {
      for (const name of names) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN "${name}"`);
    },
    reconcileContent: async () => undefined,
    ...overrides,
  };
}

// A fresh, real connection to the tree's own cache file, opened after the store that built the
// schema has closed -- reconcile() is called directly against it, the same shape open() itself uses.
function freshConnection(dbPath: string): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(dbPath);
  return { db, conn: createConnection(db) };
}

describe('reconcile orchestration', () => {
  it('nothing changed is a no-op and opens no write transaction', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);
    let beginCalls = 0;
    const dialect = baseDialect({
      beginMode: () => {
        beginCalls++;
        return BEGIN_WRITE;
      },
    });
    const result = await reconcile(conn, cfg, baseDir, dialect);

    assert.deepEqual(result, { parsed: 0, warnings: [] });
    assert.equal(beginCalls, 0, 'a no-change reconcile must never open a write transaction');
    db.close();
  });

  it('the column-limit fence fires before any ALTER lands', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B', brandNew: 'x' } });
    const { db, conn } = freshConnection(dbPath);
    const dialect = baseDialect({
      checkColumnLimit: () => {
        throw new SenseError('COLUMN_LIMIT', 'too many columns for this test');
      },
    });

    await assert.rejects(reconcile(conn, cfg, baseDir, dialect), /too many columns for this test/);

    const columns = await getColumns(conn);
    assert.ok(!columns.has('brandNew'), 'no ALTER should have landed once the fence threw');

    const row = await (await conn.prepare('SELECT "path" FROM frontmatter WHERE "path" = ?')).get('b.md');
    assert.equal(row, undefined, 'the new file was never upserted either, since the fence throws before the write transaction opens');

    db.close();
  });

  it('a column added concurrently between the outer read and the write transaction is not re-ALTERed', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B', brandNew: 'x' } });
    const { db, conn } = freshConnection(dbPath);
    const dialect = baseDialect({
      checkColumnLimit: () => {
        // Simulates a second writer landing the column between this reconcile's outer
        // read (before this call) and the write transaction's re-read (after it).
        const concurrent = new DatabaseSync(dbPath);
        try {
          concurrent.exec(`ALTER TABLE frontmatter ADD COLUMN "brandNew"`);
        } finally {
          concurrent.close();
        }
      },
    });

    const result = await reconcile(conn, cfg, baseDir, dialect);
    assert.equal(result.parsed, 1, 'the concurrently added column must not block the file from reconciling');

    const row = await (await conn.prepare('SELECT "brandNew" FROM frontmatter WHERE "path" = ?')).get('b.md');
    assert.deepEqual(row, { brandNew: 'x' });

    db.close();
  });

  it('recordDuration is optional; when provided it receives a non-negative duration', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);

    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const withoutDuration = baseDialect();
    const first = await reconcile(conn, cfg, baseDir, withoutDuration);
    assert.equal(first.parsed, 1);

    writeNote(baseDir, 'c.md', { frontmatter: { title: 'C' } });
    let recorded: number | undefined;
    const withDuration = baseDialect({
      recordDuration: async (_conn, ms) => {
        recorded = ms;
      },
    });
    const second = await reconcile(conn, cfg, baseDir, withDuration);
    assert.equal(second.parsed, 1);
    assert.ok(typeof recorded === 'number' && recorded >= 0, `expected a non-negative duration, got ${recorded}`);

    db.close();
  });

  it('reconcileContent is called exactly once, receiving the touched paths and the parsed docs', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    writeNote(baseDir, 'c.md', { frontmatter: { title: 'C' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    rmSync(join(baseDir, 'c.md'));
    const future = new Date(Date.now() + 5000);
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A2' } });
    utimesSync(join(baseDir, 'a.md'), future, future);
    writeNote(baseDir, 'd.md', { frontmatter: { title: 'D' } });

    const { db, conn } = freshConnection(dbPath);
    const calls: Array<{ touched: string[]; docs: string[] }> = [];
    const dialect = baseDialect({
      reconcileContent: async (_conn, touched, docs) => {
        calls.push({ touched: [...touched], docs: docs.map((d) => d.relPath) });
      },
    });

    await reconcile(conn, cfg, baseDir, dialect);

    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].touched].sort(), ['a.md', 'c.md']);
    assert.deepEqual([...calls[0].docs].sort(), ['a.md', 'd.md']);

    db.close();
  });

  it('forcedPaths reparses an unchanged file (stamp untouched); an unlisted file is left alone', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    // Neither file's mtime/size changes -- forcedPaths is the only reason a.md reparses.
    const { db, conn } = freshConnection(dbPath);
    const touchedCalls: string[][] = [];
    const dialect = baseDialect({
      reconcileContent: async (_conn, touched) => {
        touchedCalls.push([...touched]);
      },
    });

    const result = await reconcile(conn, cfg, baseDir, dialect, undefined, new Set(['a.md']));

    assert.equal(result.parsed, 1, 'only the forced file is reparsed');
    assert.deepEqual(touchedCalls, [['a.md']]);

    db.close();
  });

  it('a forced path no longer covered by any preset is left to the ordinary vanished computation, not double-handled', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    rmSync(join(baseDir, 'a.md'));
    const { db, conn } = freshConnection(dbPath);
    const calls: Array<{ touched: string[]; delta: { vanished: string[] } }> = [];
    const dialect = baseDialect({
      reconcileContent: async (_conn, touched, _docs, delta) => {
        calls.push({ touched: [...touched], delta: { vanished: [...delta.vanished] } });
      },
    });

    // a.md is gone from disk, so it's absent from `files` regardless of forcedPaths; it must
    // still surface exactly once, through delta.vanished, not duplicated by the force union.
    const result = await reconcile(conn, cfg, baseDir, dialect, undefined, new Set(['a.md']));

    assert.equal(result.parsed, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].touched, ['a.md']);
    assert.deepEqual(calls[0].delta.vanished, ['a.md']);

    db.close();
  });
});
