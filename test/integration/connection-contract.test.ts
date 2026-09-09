import assert from 'node:assert';
import { join } from 'node:path';
import { withTransaction } from '../../src/store/transaction.ts';
import { withNativeConnection } from '../lib/native-connection.ts';
import { scratchDir } from '../lib/scratch.ts';
import { forEachStore } from '../lib/stores.ts';

const ROWS = [
  { id: 'a', label: 'Alpha', note: 'first' },
  { id: 'b', label: 'Beta', note: null },
];

describe('native Connection contract', () => {
  it('runs the portable string/null statement surface on every store and reopens its file', async () => {
    await forEachStore(async (store) => {
      const dbPath = join(scratchDir(`connection-contract-${store}`), 'cache.db');
      await withNativeConnection(store, dbPath, async (conn) => {
        await conn.exec('CREATE TABLE records (id TEXT PRIMARY KEY, label TEXT, note TEXT)');
        const insert = await conn.prepare('INSERT INTO records VALUES (?, ?, ?)');
        for (const row of ROWS) await insert.run(row.id, row.label, row.note);

        const all = await (await conn.prepare('SELECT id, label, note FROM records ORDER BY id')).all();
        assert.deepEqual(all, ROWS, store);
        assert.deepEqual(await (await conn.prepare('SELECT id, label, note FROM records WHERE id = ?')).get('a'), ROWS[0], store);
        assert.equal(await (await conn.prepare('SELECT id FROM records WHERE id = ?')).get('missing'), undefined, store);

        const shape = await conn.prepare('SELECT id, label, note FROM records ORDER BY id');
        assert.deepEqual(
          shape.columns().map((column) => column.name),
          ['id', 'label', 'note'],
          store
        );
        const iterated: unknown[] = [];
        for await (const row of shape.iterate()) iterated.push(row);
        assert.deepEqual(iterated, ROWS, store);
      });

      await withNativeConnection(store, dbPath, async (conn) => {
        assert.deepEqual(await (await conn.prepare('SELECT id, label, note FROM records ORDER BY id')).all(), ROWS, store);
      });
    });
  });

  it('closes every native owner when the callback fails', async () => {
    await forEachStore(async (store) => {
      const dbPath = join(scratchDir(`connection-error-${store}`), 'cache.db');
      await assert.rejects(
        withNativeConnection(store, dbPath, async (conn) => {
          await conn.exec('CREATE TABLE records (id TEXT PRIMARY KEY)');
          throw new Error('intentional fixture failure');
        }),
        /intentional fixture failure/
      );

      await withNativeConnection(store, dbPath, async (conn) => {
        assert.deepEqual(await (await conn.prepare('SELECT id FROM records ORDER BY id')).all(), [], store);
      });
    });
  });

  it('runBatch rolls back a standalone duplicate-key batch and leaves the connection usable', async () => {
    await forEachStore(async (store) => {
      const dbPath = join(scratchDir(`connection-batch-rollback-${store}`), 'cache.db');
      await withNativeConnection(store, dbPath, async (conn) => {
        await conn.exec('CREATE TABLE records (id TEXT PRIMARY KEY, note TEXT)');
        const insert = 'INSERT INTO records VALUES (?, ?)';
        await conn.runBatch(insert, [['committed', 'before']]);
        await assert.rejects(
          conn.runBatch(insert, [
            ['attempted', 'first'],
            ['committed', 'duplicate'],
            ['unreached', 'last'],
          ])
        );
        assert.deepEqual(await (await conn.prepare('SELECT id, note FROM records ORDER BY id')).all(), [{ id: 'committed', note: 'before' }], store);
        await conn.runBatch(insert, [['usable', 'after failure']]);
        assert.deepEqual(
          await (await conn.prepare('SELECT id, note FROM records ORDER BY id')).all(),
          [
            { id: 'committed', note: 'before' },
            { id: 'usable', note: 'after failure' },
          ],
          store
        );
      });
    });
  });

  it('runBatch treats an empty batch as a no-op', async () => {
    await forEachStore(async (store) => {
      const dbPath = join(scratchDir(`connection-batch-empty-${store}`), 'cache.db');
      await withNativeConnection(store, dbPath, async (conn) => {
        await conn.exec('CREATE TABLE records (id TEXT PRIMARY KEY, note TEXT)');
        await conn.runBatch('INSERT INTO records VALUES (?, ?)', [['committed', 'before']]);
        await conn.runBatch('INSERT INTO records VALUES (?, ?)', []);
        assert.deepEqual(await (await conn.prepare('SELECT id, note FROM records')).all(), [{ id: 'committed', note: 'before' }], store);
      });
    });
  });

  it('runBatch joins an outer transaction across multiple batches and rolls back together', async () => {
    await forEachStore(async (store) => {
      const dbPath = join(scratchDir(`connection-batch-outer-${store}`), 'cache.db');
      await withNativeConnection(store, dbPath, async (conn) => {
        await conn.exec('CREATE TABLE records (id TEXT PRIMARY KEY, note TEXT)');
        const insert = 'INSERT INTO records VALUES (?, ?)';
        await assert.rejects(
          withTransaction(conn, async () => {
            await conn.runBatch(insert, [['outer-first', 'one']]);
            await conn.runBatch(insert, [['outer-second', 'two']]);
            throw new Error('outer batch rollback marker');
          }),
          /outer batch rollback marker/
        );
        assert.deepEqual(await (await conn.prepare('SELECT id, note FROM records')).all(), [], store);
        await withTransaction(conn, async () => {
          await conn.runBatch(insert, [['reusable-first', 'three']]);
          await conn.runBatch(insert, [['reusable-second', 'four']]);
        });
        assert.deepEqual(
          await (await conn.prepare('SELECT id, note FROM records ORDER BY id')).all(),
          [
            { id: 'reusable-first', note: 'three' },
            { id: 'reusable-second', note: 'four' },
          ],
          store
        );
      });
    });
  });
});
