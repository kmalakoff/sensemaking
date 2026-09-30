import assert from 'node:assert';
import { rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { ResolvedConfig } from 'sensemaking';
import { pagerank } from '../../../../src/graph/graph.ts';
import { parseSource } from '../../../../src/scan/index.ts';
import { createConnection, type DuckdbConnection } from '../../../../src/store/duckdb/connection.ts';
import { duckdbApi } from '../../../../src/store/duckdb/native.ts';
import { duckdbDialect } from '../../../../src/store/duckdb/reconcile.ts';
import { openStoreFor } from '../../../../src/store/index.ts';
import type { BuildRequirement } from '../../../../src/store/open.ts';
import { CORE_GENERATION_META_KEY } from '../../../../src/store/readiness.ts';
import { getMeta, setMeta } from '../../../../src/store/shared.ts';
import { withTransaction } from '../../../../src/store/transaction.ts';
import type { Connection } from '../../../../src/store/types.ts';
import { openConfig, tmpTree, writeNote } from '../../../lib/tree.ts';

function duckdbTree(baseDir: string) {
  return openConfig({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null } as Parameters<typeof openConfig>[0]);
}

async function withContentConnection(fn: (conn: Connection) => Promise<void>): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  let native: DuckDBConnection | undefined;
  const errors: unknown[] = [];
  try {
    native = await instance.connect();
    const conn = createConnection(native);
    await conn.exec('CREATE TABLE content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    await fn(conn);
  } catch (err) {
    errors.push(err);
  }
  try {
    native?.disconnectSync();
  } catch (err) {
    errors.push(err);
  }
  try {
    instance.closeSync();
  } catch (err) {
    errors.push(err);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'content test and native cleanup failed');
}

function contentDoc(path: string, title: string, summary: string, body: string) {
  const source = `---\ntitle: ${JSON.stringify(title)}\nsummary: ${JSON.stringify(summary)}\n---\n\n${body}\n`;
  return parseSource({ relPath: path, absPath: path, mtimeMs: 1, ctimeMs: 1, size: Buffer.byteLength(source), presets: ['default'], embed: false }, source).doc;
}

describe('reconcile (duckdb)', () => {
  it('writes only a changed stamp, skips identical rows and preserves exact VARIANT tag changes and removals', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, "_mtime" DOUBLE, title VARIANT, count VARIANT, ratio VARIANT, removed VARIANT, uncertain VARIANT, owned TEXT DEFAULT \'Keep\')');
      await appendRows('frontmatter', ['path', '_mtime', 'title', 'count', 'ratio', 'removed', 'uncertain'], [['a.md', 1, 'Same', BigInt(7), 0.25, 'Remove', 7]]);
      assert.deepEqual(await (await conn.prepare('SELECT variant_typeof(count) AS count_type, variant_typeof(ratio) AS ratio_type, variant_typeof(uncertain) AS uncertain_type FROM frontmatter')).all(), [{ count_type: 'INT128', ratio_type: 'DOUBLE', uncertain_type: 'INT32' }]);
      const native = (conn as DuckdbConnection).duckdb;
      const prepare = native.prepare.bind(native);
      const createAppender = native.createAppender.bind(native);
      const mutations: string[] = [];
      let appenders = 0;
      native.prepare = async (sql) => {
        if (sql.startsWith('UPDATE frontmatter SET')) mutations.push(sql);
        return prepare(sql);
      };
      native.createAppender = async (...args) => {
        ++appenders;
        return createAppender(...args);
      };
      try {
        const columns = ['path', '_mtime', 'title', 'count', 'ratio', 'removed'];
        const row = ['a.md', 2, 'Same', BigInt(7), 0.25, 'Remove'];
        await withTransaction(conn, () => updateFrontmatter(conn, columns, [row]));
        assert.deepEqual(mutations, ['UPDATE frontmatter SET "_mtime" = ? WHERE "path" = ?']);
        mutations.length = 0;
        await withTransaction(conn, () => updateFrontmatter(conn, columns, [row]));
        assert.deepEqual(mutations, [], 'an exact identical row performs no update');
        assert.equal(appenders, 0, 'existing rows never use the repair appender');

        await conn.exec('UPDATE frontmatter SET count = CAST(7 AS BIGINT)::VARIANT');
        assert.deepEqual(await (await conn.prepare('SELECT count, variant_typeof(count) AS count_type FROM frontmatter')).all(), [{ count: 7, count_type: 'INT64' }]);
        await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'count'], [['a.md', BigInt(7)]]));
        assert.deepEqual(mutations, ['UPDATE frontmatter SET "count" = ? WHERE "path" = ?']);
        assert.deepEqual(await (await conn.prepare('SELECT count, variant_typeof(count) AS count_type FROM frontmatter')).all(), [{ count: 7, count_type: 'INT128' }]);

        mutations.length = 0;
        await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'removed'], [['a.md', undefined]]));
        assert.deepEqual(mutations, ['UPDATE frontmatter SET "removed" = ? WHERE "path" = ?']);
        mutations.length = 0;
        await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'removed'], [['a.md', null]]));
        assert.deepEqual(mutations, [], 'undefined removal and SQL NULL have the same persisted value');

        // Integer numbers and supplied native wrappers are deliberately conservative.
        await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'uncertain'], [['a.md', 7]]));
        const { variantValue } = await duckdbApi();
        await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title'], [['a.md', variantValue('Same')]]));
        assert.deepEqual(mutations, ['UPDATE frontmatter SET "uncertain" = ? WHERE "path" = ?', 'UPDATE frontmatter SET "title" = ? WHERE "path" = ?']);
      } finally {
        native.prepare = prepare;
        native.createAppender = createAppender;
      }
      assert.deepEqual(await (await conn.prepare('SELECT *, variant_typeof(title) AS title_type, variant_typeof(count) AS count_type, variant_typeof(uncertain) AS uncertain_type FROM frontmatter')).all(), [
        { path: 'a.md', _mtime: 2, title: 'Same', count: 7, ratio: 0.25, removed: null, uncertain: 7, owned: 'Keep', title_type: 'VARCHAR', count_type: 'INT128', uncertain_type: 'INT32' },
      ]);
    });
  });

  it('reuses only contiguous equal update masks while preserving alternating columns and input order', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, "_mtime" DOUBLE, title VARIANT, owned TEXT DEFAULT \'Keep\')');
      await appendRows(
        'frontmatter',
        ['path', '_mtime', 'title'],
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((path) => [path, 1, 'Old'])
      );
      const native = (conn as DuckdbConnection).duckdb;
      const prepare = native.prepare.bind(native);
      const statements: string[] = [];
      const executions: string[] = [];
      native.prepare = async (sql) => {
        const stmt = await prepare(sql);
        if (sql.startsWith('UPDATE frontmatter SET')) {
          statements.push(sql);
          const bind = stmt.bind.bind(stmt);
          const run = stmt.run.bind(stmt);
          let path = '';
          stmt.bind = (values, types) => {
            assert.ok(Array.isArray(values));
            path = values[values.length - 1] as string;
            bind(values, types);
          };
          stmt.run = async () => {
            const result = await run();
            executions.push(path);
            return result;
          };
        }
        return stmt;
      };
      try {
        await withTransaction(conn, () =>
          updateFrontmatter(
            conn,
            ['path', '_mtime', 'title'],
            [
              ['h', 1, 'H'],
              ['g', 1, 'G'],
              ['f', 2, 'Old'],
              ['e', 3, 'Old'],
              ['d', 1, 'D'],
              ['c', 1, 'C'],
              ['b', 4, 'Old'],
              ['a', 5, 'Old'],
            ]
          )
        );
      } finally {
        native.prepare = prepare;
      }
      assert.deepEqual(statements, ['UPDATE frontmatter SET "title" = ? WHERE "path" = ?', 'UPDATE frontmatter SET "_mtime" = ? WHERE "path" = ?', 'UPDATE frontmatter SET "title" = ? WHERE "path" = ?', 'UPDATE frontmatter SET "_mtime" = ? WHERE "path" = ?']);
      assert.deepEqual(executions, ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']);
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter ORDER BY "path"')).all(), [
        { path: 'a', _mtime: 5, title: 'Old', owned: 'Keep' },
        { path: 'b', _mtime: 4, title: 'Old', owned: 'Keep' },
        { path: 'c', _mtime: 1, title: 'C', owned: 'Keep' },
        { path: 'd', _mtime: 1, title: 'D', owned: 'Keep' },
        { path: 'e', _mtime: 3, title: 'Old', owned: 'Keep' },
        { path: 'f', _mtime: 2, title: 'Old', owned: 'Keep' },
        { path: 'g', _mtime: 1, title: 'G', owned: 'Keep' },
        { path: 'h', _mtime: 1, title: 'H', owned: 'Keep' },
      ]);
    });
  });

  it('updates across the lookup boundary in input order with exact feature values and missing-row defaults', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec(`CREATE TABLE frontmatter (
        "path" TEXT PRIMARY KEY, owned_big BIGINT DEFAULT 9007199254740993,
        title VARIANT, owned_variant VARIANT DEFAULT CAST(8 AS BIGINT),
        "_mtime" DOUBLE, owned_null TEXT DEFAULT 'fallback', removed VARIANT,
        owned_flag BOOLEAN DEFAULT true, owned_blob BLOB DEFAULT from_hex('00FF10')
      )`);
      const seed = Array.from({ length: 130 }, (_, i) => [`n${String(i).padStart(3, '0')}.md`, BigInt('9007199254740993') + BigInt(i), `Old ${i}`, BigInt(i), i, null, 'remove me', i % 2 === 0]);
      await appendRows('frontmatter', ['path', 'owned_big', 'title', 'owned_variant', '_mtime', 'owned_null', 'removed', 'owned_flag'], seed);
      await conn.exec(`UPDATE frontmatter SET owned_blob = from_hex('DEAD00BEEF') WHERE "path" = 'n128.md'`);
      await appendRows('frontmatter', ['path', 'title', '_mtime'], [['untouched.md', 'Keep', 7]]);
      // The pinned binding infers HUGEINT for JS bigint; the SQL BIGINT default
      // is INT64. Prove the fixture's tags before testing native preservation.
      assert.deepEqual(await (await conn.prepare('SELECT "path", variant_typeof(owned_variant) AS variant_type FROM frontmatter ORDER BY "path"')).all(), [...Array.from({ length: 130 }, (_, i) => ({ path: `n${String(i).padStart(3, '0')}.md`, variant_type: 'INT128' })), { path: 'untouched.md', variant_type: 'INT64' }]);
      const rows = Array.from({ length: 130 }, (_, position) => {
        const i = 129 - position;
        return [i % 2 === 0 ? null : `New ${i}`, `n${String(i).padStart(3, '0')}.md`, 1000 + i, `Title ${i}`];
      });
      rows.splice(128, 0, [null, 'missing.md', 5000, 'Missing']);
      const untouchedRowid = await (await conn.prepare('SELECT rowid FROM frontmatter WHERE "path" = ?')).get('untouched.md');
      const native = (conn as DuckdbConnection).duckdb;
      const prepare = native.prepare.bind(native);
      const executions: string[] = [];
      let updateStatements = 0;
      native.prepare = async (sql) => {
        const stmt = await prepare(sql);
        if (sql.startsWith('UPDATE frontmatter SET')) {
          ++updateStatements;
          const bind = stmt.bind.bind(stmt);
          const run = stmt.run.bind(stmt);
          let path = '';
          stmt.bind = (values, types) => {
            assert.ok(Array.isArray(values));
            path = values[values.length - 1] as string;
            bind(values, types);
          };
          stmt.run = async () => {
            const result = await run();
            executions.push(path);
            return result;
          };
        }
        return stmt;
      };
      try {
        await withTransaction(conn, () => updateFrontmatter(conn, ['removed', 'path', '_mtime', 'title'], rows));
      } finally {
        native.prepare = prepare;
      }
      const actual = await (
        await conn.prepare(`SELECT "path", owned_big, title, owned_variant,
        variant_typeof(owned_variant) AS variant_type, "_mtime", owned_null, removed, owned_flag, hex(owned_blob) AS blob_hex
        FROM frontmatter ORDER BY "path"`)
      ).all();
      const expected = [
        { path: 'missing.md', owned_big: BigInt('9007199254740993'), title: 'Missing', owned_variant: 8, variant_type: 'INT64', _mtime: 5000, owned_null: 'fallback', removed: null, owned_flag: true, blob_hex: '00FF10' },
        ...Array.from({ length: 130 }, (_, i) => ({
          path: `n${String(i).padStart(3, '0')}.md`,
          owned_big: BigInt('9007199254740993') + BigInt(i),
          title: `Title ${i}`,
          owned_variant: i,
          variant_type: 'INT128',
          _mtime: 1000 + i,
          owned_null: null,
          removed: i % 2 === 0 ? null : `New ${i}`,
          owned_flag: i % 2 === 0,
          blob_hex: i === 128 ? 'DEAD00BEEF' : '00FF10',
        })),
        { path: 'untouched.md', owned_big: BigInt('9007199254740993'), title: 'Keep', owned_variant: 8, variant_type: 'INT64', _mtime: 7, owned_null: 'fallback', removed: null, owned_flag: true, blob_hex: '00FF10' },
      ];
      assert.deepEqual(actual, expected);
      assert.deepEqual(await (await conn.prepare('SELECT rowid FROM frontmatter WHERE "path" = ?')).get('untouched.md'), untouchedRowid);
      assert.deepEqual(
        executions,
        Array.from({ length: 130 }, (_, i) => `n${String(129 - i).padStart(3, '0')}.md`)
      );
      assert.equal(updateStatements, 2, 'contiguous updates reuse one statement per lookup chunk');
    });
  });

  it('rolls back earlier update chunks and additions after a late native failure, then reuses the connection', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, title VARIANT NOT NULL, owned DOUBLE DEFAULT 0.75, removed VARIANT)');
      const seed = Array.from({ length: 130 }, (_, i) => [`n${String(i).padStart(3, '0')}.md`, `Old ${i}`, 0.25 + i, 'Old field']);
      await appendRows('frontmatter', ['path', 'title', 'owned', 'removed'], seed);
      const before = await (await conn.prepare('SELECT * FROM frontmatter ORDER BY "path"')).all();
      const updates: unknown[][] = Array.from({ length: 130 }, (_, i) => [`n${String(i).padStart(3, '0')}.md`, i === 129 ? null : `New ${i}`, null]);
      await assert.rejects(
        () =>
          withTransaction(conn, async () => {
            await appendRows('frontmatter', ['path', 'title'], [['added.md', 'Added']]);
            await updateFrontmatter(conn, ['path', 'title', 'removed'], updates);
          }),
        /[Cc]onstraint|NOT NULL/
      );
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter ORDER BY "path"')).all(), before);
      updates[129][1] = 'New 129';
      await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title', 'removed'], updates));
      assert.deepEqual(
        await (await conn.prepare('SELECT * FROM frontmatter ORDER BY "path"')).all(),
        Array.from({ length: 130 }, (_, i) => ({ path: `n${String(i).padStart(3, '0')}.md`, title: `New ${i}`, owned: 0.25 + i, removed: null }))
      );
    });
  });

  it('preserves arbitrary lookup and native statement cleanup failures and remains reusable', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, title VARIANT)');
      await appendRows('frontmatter', ['path', 'title'], [['a.md', 'Old']]);
      const native = (conn as DuckdbConnection).duckdb;
      const prepare = native.prepare.bind(native);
      native.prepare = async (sql) => {
        const stmt = await prepare(sql);
        const read = stmt.runAndReadAll.bind(stmt);
        const destroy = stmt.destroySync.bind(stmt);
        stmt.runAndReadAll = async (...args) => {
          await read(...args);
          throw null;
        };
        stmt.destroySync = () => {
          stmt.destroySync = destroy;
          destroy();
          throw undefined;
        };
        return stmt;
      };
      try {
        await assert.rejects(
          () => withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title'], [['a.md', 'New']])),
          (err: unknown) => {
            assert.ok(err instanceof AggregateError);
            assert.deepEqual(err.errors, [null, undefined]);
            return true;
          }
        );
      } finally {
        native.prepare = prepare;
      }
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter')).all(), [{ path: 'a.md', title: 'Old' }]);
      await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title'], [['a.md', 'New']]));
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter')).all(), [{ path: 'a.md', title: 'New' }]);
    });
  });

  it('preserves UPDATE execution and destroy failures, rolls back the real write and remains reusable', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, title VARIANT)');
      await appendRows('frontmatter', ['path', 'title'], [['a.md', 'Old']]);
      const native = (conn as DuckdbConnection).duckdb;
      const prepare = native.prepare.bind(native);
      let executions = 0;
      let destructions = 0;
      native.prepare = async (sql) => {
        const stmt = await prepare(sql);
        if (sql.startsWith('UPDATE frontmatter SET')) {
          const run = stmt.run.bind(stmt);
          const destroy = stmt.destroySync.bind(stmt);
          stmt.run = async () => {
            await run();
            ++executions;
            throw null;
          };
          stmt.destroySync = () => {
            stmt.destroySync = destroy;
            destroy();
            ++destructions;
            throw undefined;
          };
        }
        return stmt;
      };
      try {
        await assert.rejects(
          () => withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title'], [['a.md', 'New']])),
          (err: unknown) => {
            assert.ok(err instanceof AggregateError);
            assert.deepEqual(err.errors, [null, undefined]);
            return true;
          }
        );
      } finally {
        native.prepare = prepare;
      }
      assert.equal(executions, 1);
      assert.equal(destructions, 1);
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter')).all(), [{ path: 'a.md', title: 'Old' }]);
      await withTransaction(conn, () => updateFrontmatter(conn, ['path', 'title'], [['a.md', 'New']]));
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter')).all(), [{ path: 'a.md', title: 'New' }]);
    });
  });

  it('preserves arbitrary body and appender cleanup failures during missing-row repair and remains reusable', async () => {
    await withContentConnection(async (conn) => {
      const updateFrontmatter = duckdbDialect.updateFrontmatter;
      const appendRows = conn.appendRows?.bind(conn);
      assert.ok(updateFrontmatter);
      assert.ok(appendRows);
      await conn.exec('CREATE TABLE frontmatter ("path" TEXT PRIMARY KEY, title VARIANT, owned TEXT DEFAULT \'default\')');
      await appendRows('frontmatter', ['path', 'title', 'owned'], [['a.md', 'Old', 'Keep']]);
      const native = (conn as DuckdbConnection).duckdb;
      const createAppender = native.createAppender.bind(native);
      native.createAppender = async (...args) => {
        const appender = await createAppender(...args);
        const flush = appender.flushSync.bind(appender);
        const close = appender.closeSync.bind(appender);
        appender.flushSync = () => {
          flush();
          throw undefined;
        };
        appender.closeSync = () => {
          close();
          appender.closeSync = close;
          throw null;
        };
        return appender;
      };
      try {
        await assert.rejects(
          () =>
            withTransaction(conn, () =>
              updateFrontmatter(
                conn,
                ['path', 'title'],
                [
                  ['a.md', 'New'],
                  ['missing.md', 'Repair'],
                ]
              )
            ),
          (err: unknown) => {
            assert.ok(err instanceof AggregateError);
            assert.deepEqual(err.errors, [undefined, null]);
            return true;
          }
        );
      } finally {
        native.createAppender = createAppender;
      }
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter')).all(), [{ path: 'a.md', title: 'Old', owned: 'Keep' }]);
      await withTransaction(conn, () =>
        updateFrontmatter(
          conn,
          ['path', 'title'],
          [
            ['a.md', 'New'],
            ['missing.md', 'Repair'],
          ]
        )
      );
      assert.deepEqual(await (await conn.prepare('SELECT * FROM frontmatter ORDER BY "path"')).all(), [
        { path: 'a.md', title: 'New', owned: 'Keep' },
        { path: 'missing.md', title: 'Repair', owned: 'default' },
      ]);
    });
  });

  it('an identical-content reparse publishes mtime, unrelated frontmatter and a new core generation', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Title', summary: 'Summary', priority: 1 }, body: 'Unchanged body.' });
    const first = await duckdbTree(baseDir);
    let content: unknown[];
    let generation: number;
    try {
      content = await (await first.store.prepare('SELECT * FROM content')).all();
      generation = Number(await getMeta(first.store, CORE_GENERATION_META_KEY));
    } finally {
      await first.store.close();
    }
    const file = join(baseDir, 'a.md');
    const mtime = statSync(file).mtimeMs + 10_000;
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'Title', summary: 'Summary', priority: 2 }, body: 'Unchanged body.' });
    utimesSync(file, mtime / 1000, mtime / 1000);
    const second = await duckdbTree(baseDir);
    try {
      assert.equal(second.parsed, 1);
      assert.deepEqual(await (await second.store.prepare('SELECT * FROM content')).all(), content);
      assert.deepEqual(await (await second.store.prepare('SELECT "_mtime", priority FROM frontmatter')).get(), { _mtime: statSync(file).mtimeMs, priority: BigInt(2) });
      assert.equal(Number(await getMeta(second.store, CORE_GENERATION_META_KEY)), generation + 1);
    } finally {
      await second.store.close();
    }
  });

  it('compares exact content across lookup chunks, repairs missing/null values and preserves added order', async () => {
    await withContentConnection(async (conn) => {
      const seed = Array.from({ length: 132 }, (_, i) => [`n${String(i).padStart(3, '0')}.md`, `Title ${i}`, `Summary ${i}`, `Body ${i}`]);
      await conn.runBatch('INSERT INTO content VALUES (?, ?, ?, ?)', [...seed, ['vanished.md', 'Gone', '', 'Gone body']]);
      await conn.exec(`UPDATE content SET summary = NULL WHERE "path" = 'n130.md'; DELETE FROM content WHERE "path" = 'n131.md'`);
      await setMeta(conn, 'fts_stale', '0');
      const before = await (await conn.prepare(`SELECT "path", rowid FROM content WHERE "path" IN ('n126.md', 'n129.md') ORDER BY "path"`)).all();
      // Authored expected values: case and canonically equivalent Unicode still differ exactly.
      const expected = seed.map((row) => [...row]);
      expected[3][1] = 'title 3';
      expected[127][2] = 'Café';
      expected[128][3] = 'Changed body 128';
      expected[130][2] = '';
      await conn.exec(`UPDATE content SET summary = 'Café' WHERE "path" = 'n127.md'`);
      const docs = [contentDoc('z-added.md', 'Z', '', 'Z body'), ...expected.map(([path, title, summary, body]) => contentDoc(path, title, summary, body)), contentDoc('a-added.md', 'A', '', 'A body')];
      const touched = [...seed.map(([path]) => path), 'vanished.md', 'absent.md'];
      await withTransaction(conn, () => duckdbDialect.reconcileContent(conn, touched, docs, { files: [], reparsed: docs.map((doc) => doc.relPath), added: ['z-added.md', 'a-added.md'], vanished: ['vanished.md', 'absent.md'] }, { presets: {}, queries: {} }));
      const rows = await (await conn.prepare('SELECT "path", title, summary, text FROM content ORDER BY "path"')).all();
      const expectedRows = [...expected, ['z-added.md', 'Z', '', 'Z body'], ['a-added.md', 'A', '', 'A body']].sort(([a], [b]) => a.localeCompare(b)).map(([path, title, summary, text]) => ({ path, title, summary, text }));
      assert.deepEqual(rows, expectedRows);
      assert.deepEqual(await (await conn.prepare(`SELECT "path", rowid FROM content WHERE "path" IN ('n126.md', 'n129.md') ORDER BY "path"`)).all(), before, 'identical rows on either side of the chunk boundary must remain in place');
      const insertionOrder = (await (await conn.prepare('SELECT "path" FROM content ORDER BY rowid')).all()) as Array<{ path: string }>;
      assert.deepEqual(
        insertionOrder.slice(-7).map((row) => row.path),
        ['z-added.md', 'n003.md', 'n127.md', 'n128.md', 'n130.md', 'n131.md', 'a-added.md']
      );
      assert.equal(await getMeta(conn, 'fts_stale'), '1');
    });
  });

  it('does not invalidate FTS for an already absent vanished path, but does for an actual deletion', async () => {
    await withContentConnection(async (conn) => {
      await conn.runBatch('INSERT INTO content VALUES (?, ?, ?, ?)', [['a.md', 'A', '', 'Body']]);
      await setMeta(conn, 'fts_stale', '0');
      await withTransaction(conn, () => duckdbDialect.reconcileContent(conn, ['absent.md'], [], { files: [], reparsed: [], added: [], vanished: ['absent.md'] }, { presets: {}, queries: {} }));
      assert.equal(await getMeta(conn, 'fts_stale'), '0');
      await withTransaction(conn, () => duckdbDialect.reconcileContent(conn, ['a.md'], [], { files: [], reparsed: [], added: [], vanished: ['a.md'] }, { presets: {}, queries: {} }));
      assert.deepEqual(await (await conn.prepare('SELECT * FROM content')).all(), []);
      assert.equal(await getMeta(conn, 'fts_stale'), '1');
    });
  });

  it('rolls back content and stale publication on failure, preserves added conflicts and permits reuse', async () => {
    await withContentConnection(async (conn) => {
      const seed = [
        { path: 'a.md', title: 'A', summary: '', text: 'Original' },
        { path: 'orphan.md', title: 'Orphan', summary: '', text: 'Existing' },
      ];
      await conn.runBatch(
        'INSERT INTO content VALUES (?, ?, ?, ?)',
        seed.map((row) => [row.path, row.title, row.summary, row.text])
      );
      await setMeta(conn, 'fts_stale', '0');
      const docs = [contentDoc('a.md', 'A', '', 'Changed'), contentDoc('new.md', 'New', '', 'New body')];
      const delta = { files: [], reparsed: ['a.md', 'new.md'], added: ['new.md'], vanished: [] };
      const failure = new Error('publication failed after content');
      await assert.rejects(
        () =>
          withTransaction(conn, async () => {
            await duckdbDialect.reconcileContent(conn, ['a.md'], docs, delta, { presets: {}, queries: {} });
            assert.equal(await getMeta(conn, 'fts_stale'), '1');
            throw failure;
          }),
        (err: unknown) => err === failure
      );
      assert.deepEqual(await (await conn.prepare('SELECT * FROM content ORDER BY "path"')).all(), seed);
      assert.equal(await getMeta(conn, 'fts_stale'), '0');
      const conflict = contentDoc('orphan.md', 'Orphan', '', 'Existing');
      // Appender cleanup can surface the aborted transaction instead of the constraint error.
      await assert.rejects(
        () => withTransaction(conn, () => duckdbDialect.reconcileContent(conn, ['a.md'], [...docs, conflict], { ...delta, reparsed: [...delta.reparsed, 'orphan.md'], added: [...delta.added, 'orphan.md'] }, { presets: {}, queries: {} })),
        /[Dd]uplicate|[Cc]onstraint|Failed to append: Current transaction is aborted/
      );
      assert.deepEqual(await (await conn.prepare('SELECT * FROM content ORDER BY "path"')).all(), seed);
      assert.equal(await getMeta(conn, 'fts_stale'), '0');
      await withTransaction(conn, () => duckdbDialect.reconcileContent(conn, ['a.md'], docs, delta, { presets: {}, queries: {} }));
      assert.deepEqual(await (await conn.prepare('SELECT * FROM content ORDER BY "path"')).all(), [{ path: 'a.md', title: 'A', summary: '', text: 'Changed' }, { path: 'new.md', title: 'New', summary: '', text: 'New body' }, seed[1]]);
      assert.equal(await getMeta(conn, 'fts_stale'), '1');
    });
  });

  it('dynamic frontmatter columns hold mixed types across files (VARIANT), read back as plain JS values', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { priority: 5, title: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { priority: 'high', title: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", priority FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; priority: unknown }>;
    assert.equal(rows[0].priority, BigInt(5));
    assert.equal(rows[1].priority, 'high');
    await store.close();
  });

  it('a vanished file is removed from frontmatter and its feature-owned rows', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A', tags: ['x'] } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    rmSync(join(baseDir, 'a.md'));
    const second = await duckdbTree(baseDir);
    const fm = await (await second.store.prepare('SELECT "path" FROM frontmatter')).all();
    assert.deepEqual(fm, []);
    const tags = await (await second.store.prepare('SELECT "path" FROM tags')).all();
    assert.deepEqual(tags, []);
    await second.store.close();
  });

  it('a reparsed file keeps its row and updates values in place', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\ntitle: "A2"\n---\n\nbody\n');
    const second = await duckdbTree(baseDir);
    assert.equal(second.parsed, 1);
    const row = (await (await second.store.prepare('SELECT title FROM frontmatter WHERE "path" = ?')).get('a.md')) as { title: string };
    assert.equal(row.title, 'A2');
    await second.store.close();
  });

  it('the links feature resolves wikilinks and populates backlinks (row-tuple stale delete, no char(0))', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[b]] again, plus ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
    const edges = (await (await store.prepare('SELECT src, dst, embed FROM links ORDER BY embed')).all()) as Array<{ src: string; dst: string; embed: number }>;
    assert.deepEqual(
      edges.map((e) => [e.src, e.dst, e.embed]),
      [
        ['a.md', 'b.md', 0],
        ['a.md', 'b.md', 1],
      ]
    );
    await store.close();
  });

  it('re-parsing a linked file with a dropped link removes the stale row without leaving orphans', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    writeNote(baseDir, 'c.md', { body: 'target' });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeFileSync(join(baseDir, 'a.md'), '---\n---\n\nSee [[c]] only.\n');
    const second = await duckdbTree(baseDir);
    const targets = (await (await second.store.prepare('SELECT target FROM links WHERE src = ?')).all('a.md')) as Array<{ target: string }>;
    assert.deepEqual(
      targets.map((t) => t.target),
      ['c']
    );
    await second.store.close();
  });

  it('sections and tags feature hooks populate their tables', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { tags: ['x'] }, body: '# Heading\n\nSome #inline-tag text.' });
    const { store } = await duckdbTree(baseDir);
    const sections = (await (await store.prepare('SELECT heading FROM sections WHERE "path" = ?')).all('a.md')) as Array<{ heading: string }>;
    assert.deepEqual(
      sections.map((s) => s.heading),
      ['Heading']
    );
    const tags = (await (await store.prepare('SELECT tag FROM tags WHERE "path" = ? ORDER BY tag')).all('a.md')) as Array<{ tag: string }>;
    assert.deepEqual(
      tags.map((t) => t.tag),
      ['inline-tag', 'x']
    );
    await store.close();
  });

  it('several new frontmatter columns discovered in one reconcile all land (duckdbDialect.addColumns joins them into one ALTER)', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { fieldA: 1, fieldB: 'x', fieldC: true } });
    writeNote(baseDir, 'b.md', { frontmatter: { fieldD: 2, fieldE: 'y' } });
    const { store } = await duckdbTree(baseDir);
    const row = (await (await store.prepare('SELECT "fieldA", "fieldB", "fieldC", "fieldD", "fieldE" FROM frontmatter WHERE "path" = ?')).get('a.md')) as Record<string, unknown>;
    assert.equal(row.fieldA, BigInt(1));
    assert.equal(row.fieldB, 'x');
    assert.equal(row.fieldC, true);
    assert.equal(row.fieldD, null);
    await store.close();
  });

  it('rank populates frontmatter._rank from the resolved link graph', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", "_rank" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; _rank: number | null }>;
    assert.ok(rows.every((r) => typeof r._rank === 'number'));
    await store.close();
  });

  it('a cold build (appender path) puts every dynamic field in its own column and leaves the feature-owned "_rank" column (sitting between core and dynamic columns) alone', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { beta: 7, gamma: 3.5, alpha: 'A' } });
    writeNote(baseDir, 'b.md', { frontmatter: { beta: 8, gamma: 4.5, alpha: 'B' } });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT "path", beta, gamma, alpha, "_rank" FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; beta: unknown; gamma: unknown; alpha: unknown; _rank: number }>;
    assert.deepEqual(
      rows.map((r) => [r.path, r.beta, r.gamma, r.alpha]),
      [
        ['a.md', BigInt(7), 3.5, 'A'],
        ['b.md', BigInt(8), 4.5, 'B'],
      ]
    );
    // The oracle: PageRank over two edgeless nodes, computed independently of reconcile's own call
    // -- not the value a misaligned appender would produce by casting a stray dynamic value into this REAL column.
    const expected = pagerank(['a.md', 'b.md'], []);
    for (const r of rows) assert.ok(Math.abs(r._rank - (expected.get(r.path) ?? 0)) < 1e-9, `${r.path}: got ${r._rank}`);
    await store.close();
  });

  it('bigint, non-integer number, string, empty string and null round-trip identically through the appender (cold build) and the bind path (reparse of an existing row)', async () => {
    const frontmatter = { big: 42, num: 3.14, str: 'hello', empty: '', missing: null };
    const columns = ['big', 'num', 'str', 'empty', 'missing'];
    const select = `SELECT ${columns.map((c) => `${c}, variant_typeof(${c}) AS ${c}_t`).join(', ')} FROM frontmatter WHERE "path" = 'a.md'`;

    const coldDir = tmpTree();
    writeNote(coldDir, 'a.md', { frontmatter });
    const cold = await duckdbTree(coldDir);
    const coldRow = (await (await cold.store.prepare(select)).get()) as Record<string, unknown>;
    await cold.store.close();

    const bindDir = tmpTree();
    writeNote(bindDir, 'a.md', { frontmatter: { title: 'seed' } });
    const seeded = await duckdbTree(bindDir);
    await seeded.store.close();
    writeNote(bindDir, 'a.md', { frontmatter });
    const bind = await duckdbTree(bindDir);
    assert.equal(bind.parsed, 1, 'expected a reparse of the existing row, not a fresh add');
    const bindRow = (await (await bind.store.prepare(select)).get()) as Record<string, unknown>;
    await bind.store.close();

    assert.deepEqual(coldRow, bindRow);
  });

  // links is the strongest alignment case: `dst` sits between target_base and embed. An
  // appender ignoring physical order would slide it into `embed`'s slot instead.
  it('a cold build appends links with dst resolved in place, not shifted into embed', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]] and ![[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT src, target, target_base, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 0 },
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 1 },
    ]);
    await store.close();
  });

  // The same alignment risk on the path a cold build no longer takes: an incrementally added
  // link still appends with dst an unwritten (NULL) column, resolved afterward by afterReconcile.
  it('an incrementally added link appends with the unwritten middle column (dst) defaulted, not shifted', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'seed.md', { body: 'seed' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { body: 'See [[b]] and ![[b]].' });
    const { store } = await duckdbTree(baseDir);
    const rows = (await (await store.prepare('SELECT src, target, target_base, dst, embed FROM links WHERE src = ? ORDER BY embed')).all('a.md')) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 0 },
      { src: 'a.md', target: 'b', target_base: 'b', dst: 'b.md', embed: 1 },
    ]);
    await store.close();
  });

  // embeddings' unwritten columns are trailing rather than interior, and NULL is what the embed
  // pass looks for to know a chunk still needs a vector.
  it('a cold build appends embedding rows with scale and vector left NULL for the embed pass', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: '# One\n\nSome prose.\n\n# Two\n\nMore prose.' });
    const { store } = await openStoreFor({ store: 'duckdb', presets: { default: { include: ['**/*.md'] } }, queries: {}, baseDir, configPath: null, embed: { model: 'minishlab/potion-retrieval-32M', provider: 'static' } } as ResolvedConfig, { build: true, requirements: new Set<BuildRequirement>(['core']) });
    const rows = (await (await store.prepare('SELECT "path", chunk, start_line, end_line, scale, vector FROM embeddings WHERE "path" = ? ORDER BY chunk')).all('a.md')) as Array<Record<string, unknown>>;
    assert.ok(rows.length > 0, 'expected at least one chunk row');
    for (const [i, row] of rows.entries()) {
      assert.equal(row.path, 'a.md');
      assert.equal(row.chunk, i, 'chunk index must land in its own column');
      assert.equal(row.scale, null);
      assert.equal(row.vector, null);
      assert.ok(typeof row.start_line === 'number' && row.start_line > 0, `start_line: ${String(row.start_line)}`);
      assert.ok((row.end_line as number) >= (row.start_line as number), 'end_line must not be a shifted value');
    }
    await store.close();
  });

  // Every table but frontmatter is statically typed, so the append path must choose appendValue by
  // the column's own type; appendVariant everywhere would make these read back as variants.
  it('appended rows on statically typed tables keep their declared types', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { tags: ['x'] }, body: '# Heading\n\nProse.' });
    const { store } = await duckdbTree(baseDir);
    const section = (await (await store.prepare('SELECT idx, level, heading, start_line, end_line, tokens FROM sections WHERE "path" = ?')).get('a.md')) as Record<string, unknown>;
    for (const key of ['idx', 'level', 'start_line', 'end_line', 'tokens']) assert.equal(typeof section[key], 'number', `${key}: ${typeof section[key]}`);
    assert.equal(section.heading, 'Heading');
    const types = (await (await store.prepare("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sections'")).all()) as Array<{ column_name: string; data_type: string }>;
    for (const t of types) assert.notEqual(t.data_type, 'VARIANT', `sections.${t.column_name} must not be VARIANT`);
    await store.close();
  });

  // The reason links.store does not delete-and-reinsert: a reparse must not reset dst, or every
  // touch looks like an edge change. The added/not-added split has to preserve that.
  it('a reparse upserts links and preserves the resolved dst, while a new path appends', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { body: 'See [[b]].' });
    writeNote(baseDir, 'b.md', { body: 'target' });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { frontmatter: { touched: 1 }, body: 'See [[b]].' });
    writeNote(baseDir, 'c.md', { body: 'See [[b]].' });
    const second = await duckdbTree(baseDir);
    const rows = (await (await second.store.prepare('SELECT src, target, dst FROM links ORDER BY src')).all()) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { src: 'a.md', target: 'b', dst: 'b.md' },
      { src: 'c.md', target: 'b', dst: 'b.md' },
    ]);
    await second.store.close();
  });

  it('a reconcile with both a new and an existing path in one call routes each correctly (appender for the new path, upsert for the existing one), with no duplication', async () => {
    const baseDir = tmpTree();
    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A1' } });
    writeNote(baseDir, 'b.md', { frontmatter: { title: 'B1' } });
    const first = await duckdbTree(baseDir);
    await first.store.close();

    writeNote(baseDir, 'a.md', { frontmatter: { title: 'A2' } });
    writeNote(baseDir, 'c.md', { frontmatter: { title: 'C1' } });
    const second = await duckdbTree(baseDir);
    assert.equal(second.parsed, 2);
    const rows = (await (await second.store.prepare('SELECT "path", title FROM frontmatter ORDER BY "path"')).all()) as Array<{ path: string; title: string }>;
    assert.deepEqual(
      rows.map((r) => [r.path, r.title]),
      [
        ['a.md', 'A2'],
        ['b.md', 'B1'],
        ['c.md', 'C1'],
      ]
    );
    await second.store.close();
  });
});
