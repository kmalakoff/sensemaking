import { statSync, utimesSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'assert';
import { PARSE_BYTES_PER_WORKER } from '../../../src/scan/reparse.ts';
import { createBuilder } from '../../../src/store/builder.ts';
import { createConnection } from '../../../src/store/sqlite/connection.ts';
import { BEGIN_WRITE } from '../../../src/store/transaction.ts';
import type { Connection, ReconcileDialect } from '../../../src/store/types.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// createBuilder (builder.ts) against a real sqlite-backed connection; reconcile.test.ts separately
// exercises the unfenced lower-level orchestration under an exclusive connection.

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

// Balanced and comfortably above two production byte shares. A one-thread host still follows
// the production serial policy; ParsePool's direct owners separately force and prove real reuse.
const FILE_COUNT = 200;
const NOTE_BODY = 'x'.repeat(8 * 1024);
const NOTE_SOURCE_BYTES = Buffer.byteLength(`---\n\n---\n\n${NOTE_BODY}\n`);

async function generation(conn: Connection): Promise<number> {
  const row = (await (await conn.prepare("SELECT value FROM meta WHERE key = 'core_generation'")).get()) as { value: string } | undefined;
  if (!row) throw new Error('missing core generation');
  return Number(row.value);
}

async function finishBuilder(builder: ReturnType<typeof createBuilder>, db: DatabaseSync, bodyFailure?: { error: unknown }): Promise<void> {
  const cleanup = await Promise.allSettled([
    Promise.resolve().then(() => builder.close()),
    Promise.resolve().then(() => {
      db.close();
    }),
  ]);
  const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
  if (bodyFailure && cleanupErrors.length > 0) throw new AggregateError([bodyFailure.error, ...cleanupErrors], 'builder test failed and cleanup also failed');
  if (bodyFailure) throw bodyFailure.error;
  if (cleanupErrors.length > 0) throw cleanupErrors.length === 1 ? cleanupErrors[0] : new AggregateError(cleanupErrors, 'builder cleanup failed');
}

describe('createBuilder', () => {
  it('build() reuses one pool, advances mutations, and preserves a no-op generation', async () => {
    const baseDir = tmpTree();
    for (let i = 0; i < FILE_COUNT; i++) writeNote(baseDir, `n${i}.md`, { body: NOTE_BODY });
    const sourceBytes = Array.from({ length: FILE_COUNT }, (_, i) => statSync(join(baseDir, `n${i}.md`)).size);
    assert.deepEqual(new Set(sourceBytes), new Set([NOTE_SOURCE_BYTES]), 'builder pool fixture files are not balanced at the authored byte size');
    const aggregateBytes = sourceBytes.reduce((sum, size) => sum + size, 0);
    assert.equal(aggregateBytes, FILE_COUNT * NOTE_SOURCE_BYTES, 'builder pool fixture aggregate bytes changed unexpectedly');
    assert.ok(aggregateBytes > 2 * PARSE_BYTES_PER_WORKER, 'builder pool fixture no longer exceeds two production byte shares');
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);
    const builder = createBuilder(conn, cfg, baseDialect(), async () => {});
    const expectedPools = availableParallelism() >= 2 ? 1 : 0;
    let bodyFailure: { error: unknown } | undefined;
    try {
      const future1 = new Date(Date.now() + 5000);
      for (let i = 0; i < FILE_COUNT; i++) utimesSync(join(baseDir, `n${i}.md`), future1, future1);
      const first = await builder.build();
      assert.equal(first.parsed, FILE_COUNT);
      assert.equal(builder.poolsCreated, expectedPools, 'first build() did not follow the production parallelism policy');
      const firstGeneration = await generation(conn);

      const future2 = new Date(Date.now() + 10000);
      for (let i = 0; i < FILE_COUNT; i++) utimesSync(join(baseDir, `n${i}.md`), future2, future2);
      const second = await builder.build();
      assert.equal(second.parsed, FILE_COUNT);
      assert.equal(builder.poolsCreated, expectedPools, 'second build() did not reuse the production-selected pool state');
      const secondGeneration = await generation(conn);
      assert.equal(secondGeneration, firstGeneration + 1);

      const noOp = await builder.build();
      assert.equal(noOp.parsed, 0);
      assert.equal(await generation(conn), secondGeneration, 'a no-op build advanced the published generation');
    } catch (error) {
      bodyFailure = { error };
    } finally {
      await finishBuilder(builder, db, bodyFailure);
    }
  });

  it('close() before any build() is a no-op', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md');
    const { store, cfg, dbPath } = await openTree(baseDir);
    await store.close();

    const { db, conn } = freshConnection(dbPath);
    const builder = createBuilder(conn, cfg, baseDialect(), async () => {});
    let bodyFailure: { error: unknown } | undefined;
    try {
      assert.equal(builder.poolsCreated, 0);
    } catch (error) {
      bodyFailure = { error };
    } finally {
      await finishBuilder(builder, db, bodyFailure);
    }
  });
});
