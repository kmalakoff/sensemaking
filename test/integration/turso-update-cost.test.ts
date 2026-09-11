import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'assert';
import { NATIVE_UPDATE_MTIME_MS as INITIAL_MTIME, NATIVE_UPDATE_NOTES as NOTES, nativeUpdateInputs, nativeUpdatePaths, nativeUpdatePath as pathFor, nativeUpdateText as textFor, NATIVE_UPDATE_NEXT_MTIME_MS as UPDATED_MTIME } from '../../benchmark/lib/native-update-contract.mjs';
import { cleanupTemporaryTree, closeForCleanup, combinedError } from '../../benchmark/lib/turso-update-cleanup.mjs';
import type { ResolvedConfig } from '../../src/config/index.ts';
import type { ReconcileDelta } from '../../src/features/types.ts';
import { listFiles, type ParsedDoc, parseFile } from '../../src/scan/index.ts';
import { BEGIN_WRITE, withTransaction } from '../../src/store/transaction.ts';
import { createConnection } from '../../src/store/turso/connection.ts';
import { queryLexical } from '../../src/store/turso/lexical.ts';
import { CONNECT_OPTS, tursoApi } from '../../src/store/turso/native.ts';
import { reconcileTursoContentWithStrategy, type TursoFtsStrategy, tursoDialect } from '../../src/store/turso/reconcile.ts';
import type { Connection } from '../../src/store/types.ts';
import { packageRoot, scratchDir } from '../lib/scratch.ts';
import { openConfig } from '../lib/tree.ts';

const CHANGED = 250;
const INPUTS = nativeUpdateInputs(CHANGED);
const QUERY_OPTIONS = INPUTS.queries.baseline.options;

function config(baseDir: string): ResolvedConfig {
  return { store: 'turso', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null };
}

interface PreparedUpdate {
  baseDir: string;
  cfg: ResolvedConfig;
  dbPath: string;
  touched: string[];
  docs: ParsedDoc[];
  delta: ReconcileDelta;
}

async function prepareUpdate(changed = CHANGED): Promise<PreparedUpdate> {
  const baseDir = scratchDir('turso-update-cost');
  const cfg = config(baseDir);
  for (let index = 0; index < NOTES; index++) {
    const path = join(baseDir, pathFor(index));
    writeFileSync(path, textFor(index));
    utimesSync(path, INITIAL_MTIME / 1000, INITIAL_MTIME / 1000);
  }
  const baseline = await openConfig(cfg);
  const dbPath = baseline.dbPath;
  try {
    const initialBaselinePaths = (await baseline.store.lexical.query(INPUTS.queries.baseline.text, QUERY_OPTIONS)).map(({ path }) => path).sort();
    assert.deepEqual(initialBaselinePaths, nativeUpdatePaths(NOTES), 'the prepared index must return every authored baseline path before close');
  } finally {
    await baseline.store.close();
  }

  const touched = Array.from({ length: changed }, (_, index) => pathFor(index));
  for (let index = 0; index < changed; index++) {
    const path = join(baseDir, pathFor(index));
    writeFileSync(path, textFor(index, true));
    utimesSync(path, UPDATED_MTIME / 1000, UPDATED_MTIME / 1000);
  }
  const files = listFiles(cfg, baseDir);
  const touchedSet = new Set(touched);
  const docs = files.filter((file) => touchedSet.has(file.relPath)).map((file) => parseFile(file).doc);
  assert.equal(docs.length, changed, 'the real parser must receive every changed file');
  return { baseDir, cfg, dbPath, touched, docs, delta: { files, reparsed: touched, added: [], vanished: [] } };
}

async function withNative<T>(prepared: PreparedUpdate, fn: (conn: Connection) => Promise<T>): Promise<T> {
  const turso = await tursoApi();
  const db = await turso.connect(prepared.dbPath, { ...CONNECT_OPTS, experimental: [...CONNECT_OPTS.experimental] });
  try {
    return await fn(createConnection(db));
  } finally {
    await db.close();
  }
}

async function pathsFor(conn: Connection, terms: string): Promise<string[]> {
  return (await queryLexical(conn, terms, QUERY_OPTIONS)).map(({ path }) => path).sort();
}

async function apply(prepared: PreparedUpdate, conn: Connection, strategy?: TursoFtsStrategy): Promise<void> {
  await withTransaction(conn, () => reconcileTursoContentWithStrategy(conn, prepared.touched, prepared.docs, strategy ?? 'incremental'), BEGIN_WRITE);
}

function expectedChanged(changed = CHANGED): string[] {
  return nativeUpdatePaths(changed);
}

function expectedBaseline(): string[] {
  return nativeUpdatePaths(NOTES);
}

describe('turso update cost strategies', () => {
  it('retries a failed close before removing a real scratch tree and preserves the primary failure', async () => {
    const tree = scratchDir('turso-update-cleanup');
    writeFileSync(join(tree, 'held.db'), 'native fixture');
    const primary = new Error('operation failed');
    let attempts = 0;
    const closed = await closeForCleanup({}, async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient close failure');
    });

    assert.equal(closed.released, true);
    assert.strictEqual(combinedError(primary, closed.error), primary);
    assert.equal(attempts, 2);
    assert.equal(cleanupTemporaryTree(tree, closed.released), null);
  });

  it('does not remove a scratch tree when repeated close attempts cannot release the resource', async () => {
    const tree = scratchDir('turso-update-close-failure');
    writeFileSync(join(tree, 'held.db'), 'native fixture');
    const primary = new Error('operation failed');
    const closed = await closeForCleanup({}, async () => {
      throw new Error('permanent close failure');
    });

    assert.equal(closed.released, false);
    assert.ok(closed.error instanceof AggregateError);
    assert.equal(cleanupTemporaryTree(tree, closed.released) instanceof Error, true);
    assert.equal(existsSync(tree), true);
    const failure = combinedError(primary, closed.error);
    assert.ok(failure instanceof AggregateError);
    assert.strictEqual(failure.errors[0], primary);
  });

  it('diagnostic help is available without starting a native operation', () => {
    const tool = join(packageRoot, 'benchmark', 'tools', 'turso-update-cost.mjs');
    const result = spawnSync(process.execPath, [tool, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /usage: node benchmark\/tools\/turso-update-cost\.mjs/);
  });

  for (const [changed, wantsRebuild] of [
    [CHANGED, false],
    [CHANGED + 1, true],
  ] as const)
    it(`production dialect ${wantsRebuild ? 'rebuilds' : 'keeps incremental'} at ${changed} changed files`, async () => {
      const prepared = await prepareUpdate(changed);
      await withNative(prepared, async (conn) => {
        const originalExec = conn.exec.bind(conn);
        const execCalls: string[] = [];
        conn.exec = async (sql) => {
          execCalls.push(sql);
          await originalExec(sql);
        };

        await withTransaction(conn, () => tursoDialect.reconcileContent(conn, prepared.touched, prepared.docs, prepared.delta, prepared.cfg), BEGIN_WRITE);
        assert.deepEqual(await pathsFor(conn, 'updated'), expectedChanged(changed));
        assert.deepEqual(await pathsFor(conn, 'baseline'), expectedBaseline());
        assert.equal(
          execCalls.some((sql) => sql.startsWith('DROP INDEX')),
          wantsRebuild,
          `${changed} must ${wantsRebuild ? '' : 'not '}drop the FTS indexes through the production dialect`
        );
        assert.equal(
          execCalls.some((sql) => sql.startsWith('CREATE INDEX')),
          wantsRebuild,
          `${changed} must ${wantsRebuild ? '' : 'not '}recreate the FTS indexes through the production dialect`
        );
      });
    });

  for (const strategy of ['incremental', 'rebuild'] as const)
    it(`${strategy}: exact 250-file content update is correct and survives a fresh public open`, async () => {
      const prepared = await prepareUpdate();
      await withNative(prepared, async (conn) => {
        await apply(prepared, conn, strategy);
        assert.deepEqual(await pathsFor(conn, 'updated'), expectedChanged());
        assert.deepEqual(await pathsFor(conn, 'baseline'), expectedBaseline());
      });

      // This connection opens the persisted cache directly, so it cannot repair the index by
      // comparing filesystem stamps and reconciling before the assertion.
      await withNative(prepared, async (conn) => {
        assert.deepEqual(await pathsFor(conn, 'updated'), expectedChanged());
        assert.deepEqual(await pathsFor(conn, 'baseline'), expectedBaseline());
      });

      const reopened = await openConfig(prepared.cfg);
      try {
        assert.deepEqual((await reopened.store.lexical.query('updated', QUERY_OPTIONS)).map(({ path }) => path).sort(), expectedChanged());
        assert.deepEqual((await reopened.store.lexical.query('baseline', QUERY_OPTIONS)).map(({ path }) => path).sort(), expectedBaseline());
      } finally {
        await reopened.store.close();
      }
    });

  it('public incremental reconciliation parameterizes quoted paths for mixed and deletion-only updates', async () => {
    const baseDir = scratchDir('turso-content-delete');
    const cfg = config(baseDir);
    const deletedPath = "delete-'one.md";
    const updatedPath = "update-'two.md";
    writeFileSync(join(baseDir, deletedPath), '# Deleted\n\nbaseline marker\n');
    writeFileSync(join(baseDir, updatedPath), '# Original\n\nbaseline marker\n');
    utimesSync(join(baseDir, deletedPath), INITIAL_MTIME / 1000, INITIAL_MTIME / 1000);
    utimesSync(join(baseDir, updatedPath), INITIAL_MTIME / 1000, INITIAL_MTIME / 1000);

    const initial = await openConfig(cfg);
    try {
      assert.deepEqual((await initial.store.lexical.query('baseline', QUERY_OPTIONS)).map(({ path }) => path).sort(), [deletedPath, updatedPath]);
    } finally {
      await initial.store.close();
    }

    unlinkSync(join(baseDir, deletedPath));
    writeFileSync(join(baseDir, updatedPath), '# Updated\n\nbaseline updated marker\n');
    utimesSync(join(baseDir, updatedPath), UPDATED_MTIME / 1000, UPDATED_MTIME / 1000);
    const mixed = await openConfig(cfg);
    try {
      assert.deepEqual(
        (await mixed.store.lexical.query('updated', QUERY_OPTIONS)).map(({ path }) => path),
        [updatedPath]
      );
      assert.deepEqual(
        (await mixed.store.lexical.query('baseline', QUERY_OPTIONS)).map(({ path }) => path),
        [updatedPath]
      );
      assert.deepEqual(await (await mixed.store.prepare('SELECT "path", text FROM content ORDER BY "path"')).all(), [{ path: updatedPath, text: 'Updated baseline updated marker' }]);
    } finally {
      await mixed.store.close();
    }

    unlinkSync(join(baseDir, updatedPath));
    const deletionOnly = await openConfig(cfg);
    try {
      assert.deepEqual(await deletionOnly.store.lexical.query('baseline', QUERY_OPTIONS), []);
      assert.deepEqual(await (await deletionOnly.store.prepare('SELECT "path", text FROM content')).all(), []);
    } finally {
      await deletionOnly.store.close();
    }
  });

  for (const strategy of ['incremental', 'rebuild'] as const)
    it(`${strategy}: a failed real transaction leaves the old FTS snapshot queryable`, async () => {
      const prepared = await prepareUpdate();
      await withNative(prepared, async (conn) => {
        await assert.rejects(
          withTransaction(
            conn,
            async () => {
              await reconcileTursoContentWithStrategy(conn, prepared.touched, prepared.docs, strategy);
              throw new Error('rollback this update');
            },
            BEGIN_WRITE
          ),
          /rollback this update/
        );
        assert.deepEqual(await pathsFor(conn, 'updated'), []);
        assert.deepEqual(await pathsFor(conn, 'baseline'), expectedBaseline());
      });
    });
});
