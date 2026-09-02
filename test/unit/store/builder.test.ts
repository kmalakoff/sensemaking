import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { createBuilder } from '../../../src/store/builder.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { BEGIN_WRITE } from '../../../src/store/transaction.ts';
import type { Connection, ReconcileDialect } from '../../../src/store/types.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// createBuilder (builder.ts) against a real sqlite-backed connection, same shape reconcile.test.ts
// uses for the lower-level reconcile() function it wraps.

function baseDialect(): ReconcileDialect {
  return {
    beginMode: () => BEGIN_WRITE,
    checkColumnLimit: () => undefined,
    addColumns: async (conn, names) => {
      for (const name of names) await conn.exec(`ALTER TABLE frontmatter ADD COLUMN "${name}"`);
    },
    reconcileContent: async () => undefined,
  };
}

function freshConnection(dbPath: string): { db: DatabaseSync; conn: Connection } {
  const db = new DatabaseSync(dbPath);
  return { db, conn: createConnection(db) };
}

const FILE_COUNT = 200; // at the pooled-dispatch threshold (src/scan/reparse.ts)

describe('createBuilder', () => {
  it('build() reuses one pool across two dispatches on the same instance, and close() releases it', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < FILE_COUNT; i++) writeNote(baseDir, `n${i}.md`);
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);
    const builder = createBuilder(conn, cfg, baseDir, baseDialect());

    const future1 = new Date(Date.now() + 5000);
    for (let i = 0; i < FILE_COUNT; i++) utimesSync(join(baseDir, `n${i}.md`), future1, future1);
    const first = await builder.build();
    assert.equal(first.parsed, FILE_COUNT);
    assert.equal(builder.poolsCreated, 1, 'first build() did not construct a pool');

    const future2 = new Date(Date.now() + 10000);
    for (let i = 0; i < FILE_COUNT; i++) utimesSync(join(baseDir, `n${i}.md`), future2, future2);
    const second = await builder.build();
    assert.equal(second.parsed, FILE_COUNT);
    assert.equal(builder.poolsCreated, 1, 'second build() constructed a second pool instead of reusing the first');

    await builder.close();
    db.close();
  });

  it('close() before any build() is a no-op', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);
    const builder = createBuilder(conn, cfg, baseDir, baseDialect());
    await builder.close();
    db.close();
  });
});
