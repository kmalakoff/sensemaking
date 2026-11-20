import type { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import type { Config, ResolvedConfig } from '../../config/index.ts';
import { STORE_DIMS } from '../../embed/types.ts';
import { SenseError } from '../../errors.ts';
import { activeFeatures } from '../../features/index.ts';
import { checkEngineStep, ENGINE_CHECK_DOCS, ENGINE_CHECK_FUNCTIONS, ENGINE_CHECK_VARIANT_COLUMNS, ENGINE_CHECK_VARIANT_ROWS, ENGINE_CHECK_VARIANT_UPDATE, ENGINE_CHECK_VECTORS, engineIdentity, npmRemedy, checkEngine as runEngineCheck } from '../engine.ts';
import { peerRange } from '../native.ts';
import type { InternalOpenOptions, OpenResult } from '../open.ts';
import { openWithDialect } from '../open.ts';
import { getMeta, quoteIdent, setMeta } from '../shared.ts';
import type { Connection, OpenDialect } from '../types.ts';
import { createConnection } from './connection.ts';
import { assertFtsReady, prepareFts, queryLexical } from './lexical.ts';
import { DUCKDB_PACKAGE, duckdbApi, duckdbNative } from './native.ts';
import { duckdbDialect } from './reconcile.ts';
import { registerFunctions } from './sql-functions.ts';
import { createStore } from './store.ts';
import { createVectorWriteStage, scanCandidates, writeVectorBatch } from './vectors.ts';

export const DB_FILENAME = 'cache.duckdb';
// Independent of sqlite's SCHEMA_VERSION -- the two stores' cache shapes evolve separately (VARIANT frontmatter columns vs untyped).
// The store name already joins the feature signature, so switching a config's `store` key rebuilds rather than reusing the other engine's cache.
export const SCHEMA_VERSION = '6';

export type { OpenResult };

// The connection plus this store's own native handles (types.ts's OpenDialect<Handle>): the
// instance owns the WAL and must outlive the connection borrowed from it.
interface DuckdbHandle {
  instance: DuckDBInstance;
  duckdb: DuckDBConnection;
}

// `content` is a plain table (not FTS-virtual): build prepares the persistent FTS index over it,
// while contains() verification reads the table directly.
// No tokenizer resolution: this store always uses the fts extension's default (porter) stemmer.
async function ensureCoreSchema(_handle: DuckdbHandle, conn: Connection): Promise<void> {
  await conn.exec(`CREATE TABLE IF NOT EXISTS frontmatter ("path" TEXT PRIMARY KEY, "_mtime" DOUBLE, "_ctime" DOUBLE, "_size" INTEGER, "_parse_error" TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS content ("path" TEXT PRIMARY KEY, title TEXT, summary TEXT, text TEXT)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS indexed_sources ("path" TEXT PRIMARY KEY, text TEXT NOT NULL)`);
  await conn.exec(`CREATE TABLE IF NOT EXISTS preset_files ("path" TEXT, preset TEXT, PRIMARY KEY ("path", preset))`);
  await conn.exec('CREATE INDEX IF NOT EXISTS preset_files_preset ON preset_files(preset)');
  if ((await getMeta(conn, 'schema_version')) === null) await setMeta(conn, 'schema_version', SCHEMA_VERSION);
}

const EMBEDDINGS_DDL = `CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, content_identity TEXT NOT NULL, scale REAL, vector FLOAT[${STORE_DIMS}], PRIMARY KEY ("path", chunk))`;

async function ensureFeatureSchema(_handle: DuckdbHandle, conn: Connection, cfg: Config): Promise<void> {
  for (const feature of activeFeatures(cfg)) {
    // Native FLOAT[STORE_DIMS] instead of the embed feature's engine-neutral BLOB+scale DDL (vectors.ts). `scale` is kept, unused,
    // so the feature's shared reconcile-time INSERT/DELETE (features/embed.ts) names a column that exists on both stores.
    if (feature.name === 'embed') {
      await conn.exec(EMBEDDINGS_DDL);
      continue;
    }
    await feature.schema(conn);
  }
}

async function prepareConnection(handle: DuckdbHandle, _conn: Connection, _cfg: Config): Promise<void> {
  await createVectorWriteStage(handle.duckdb, STORE_DIMS);
}

// Order matters: the connection must be gone before the instance closes the WAL.
async function close(handle: DuckdbHandle): Promise<void> {
  handle.duckdb.disconnectSync();
  handle.instance.closeSync();
}

async function connect(dbPath: string, _cfg: ResolvedConfig, options: { existingOnly: boolean; observational: boolean }): Promise<{ handle: DuckdbHandle; conn: Connection }> {
  // Dynamic, not a top-level import: sqlite trees must never attempt to resolve this optional peer dependency, so nothing imports
  // it as a value until a duckdb tree opens (types-only imports are erased). Installed on first use if missing, shared with sql-functions.ts and vectors.ts via native.ts's duckdbApi.
  let DuckDBInstance: typeof import('@duckdb/node-api').DuckDBInstance;
  try {
    ({ DuckDBInstance } = await duckdbApi());
  } catch (err) {
    if (err instanceof SenseError) throw err;
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" needs the ${DUCKDB_PACKAGE} package (${(err as Error).message})`);
  }

  let duckdb: DuckDBConnection;
  let instance: DuckDBInstance | undefined;
  try {
    // The default storage format rejects the VARIANT columns reconcile.ts needs, and DuckDB 2's v69 would leave the file unopenable by 1.5.
    // v1.5.0 supports VARIANT and keeps the file readable by both versions, which the engine-identity rebuild relies on.
    instance = await DuckDBInstance.create(dbPath, options.observational ? { access_mode: 'READ_ONLY' } : { storage_compatibility_version: 'v1.5.0' });
    duckdb = await instance.connect();
  } catch (err) {
    // create() may have succeeded before connect() failed: close it, or its WAL stays open.
    instance?.closeSync();
    throw new SenseError('STORE_DEPENDENCY_MISSING', `store "duckdb" failed to open ${dbPath}: ${(err as Error).message}`);
  }
  // A throw below would leak the open instance, whose WAL then locks the .duckdb file undeletable on Windows.
  try {
    await registerFunctions(duckdb);
    const conn = createConnection(duckdb);
    return { handle: { instance, duckdb }, conn };
  } catch (err) {
    await close({ instance, duckdb });
    throw err;
  }
}

async function duckdbEngineIdentity(): Promise<string> {
  return engineIdentity(DUCKDB_PACKAGE, (await duckdbNative()).version);
}

// The checks below return a description of the first mismatch, or null. Each takes the fixture as a parameter so a spec can hand the real engine a wrong expectation.

// Frontmatter VARIANT cells: appender write, read-back with the writer's type tag, and the reconcile update that keeps unchanged cells.
export async function checkVariantColumns(handle: DuckdbHandle, conn: Connection, fixture = { columns: ENGINE_CHECK_VARIANT_COLUMNS, rows: ENGINE_CHECK_VARIANT_ROWS, update: ENGINE_CHECK_VARIANT_UPDATE }): Promise<string | null> {
  const { DuckDBTypeId, DuckDBVariantValue } = await duckdbApi();
  const appendRows = conn.appendRows?.bind(conn);
  if (!appendRows) throw new Error('the duckdb connection has no appender');
  const names = fixture.columns.map((c) => c.column);
  const writable = ['path', ...names];
  await duckdbDialect.addColumns(conn, names);
  await appendRows(
    'frontmatter',
    writable,
    fixture.rows.map((row) => [row.path, ...row.values])
  );
  const mismatch = async (rows: ReadonlyArray<{ path: string; values: Array<string | bigint | number | null> }>): Promise<string | null> => {
    const reader = await handle.duckdb.runAndReadAll(`SELECT ${writable.map(quoteIdent).join(', ')} FROM frontmatter ORDER BY "path"`);
    const stored = new Map(reader.getRowObjects().map((row) => [row.path as string, row]));
    for (const row of rows) {
      for (const [i, { column, type }] of fixture.columns.entries()) {
        const cell = stored.get(row.path)?.[column];
        const want = row.values[i];
        if (want === null) {
          if (cell !== null) return `${row.path} ${column} read back as ${String(cell)}, expected NULL`;
        } else if (!(cell instanceof DuckDBVariantValue) || cell.type?.typeId !== DuckDBTypeId[type] || !Object.is(cell.value, want)) {
          return `${row.path} ${column} read back as ${cell instanceof DuckDBVariantValue ? `${String(cell.value)} (type ${cell.type?.typeId})` : String(cell)}, expected ${String(want)} (${type})`;
        }
      }
    }
    return null;
  };
  const written = await mismatch(fixture.rows);
  if (written) return written;
  const { path, column, value } = fixture.update;
  if (!duckdbDialect.updateFrontmatter) throw new Error('the duckdb dialect has no frontmatter update');
  await duckdbDialect.updateFrontmatter(conn, ['path', column], [[path, value]]);
  const column_i = fixture.columns.findIndex((c) => c.column === column);
  return mismatch(fixture.rows.map((row) => (row.path === path ? { path, values: row.values.map((v, i) => (i === column_i ? value : v)) } : row)));
}

// Vector write stage, appender array write and the native cosine scan, ranked and rounded as the search path reports them.
export async function checkVectorScan(handle: DuckdbHandle, conn: Connection, fixture = ENGINE_CHECK_VECTORS): Promise<string | null> {
  await conn.exec(EMBEDDINGS_DDL);
  await conn.runBatch(
    'INSERT INTO embeddings ("path", chunk, start_line, end_line, content_identity) VALUES (?, ?, ?, ?, ?)',
    fixture.rows.map((row) => [row.path, row.chunk, 1, 1, 'engine-check'])
  );
  await createVectorWriteStage(handle.duckdb, STORE_DIMS);
  const rows = fixture.rows.map((row) => {
    const quantized = new Int8Array(STORE_DIMS);
    quantized.set(row.head);
    return { path: row.path, chunk: row.chunk, scale: fixture.scale, vector: Buffer.from(quantized.buffer) };
  });
  await writeVectorBatch(handle.duckdb, conn, STORE_DIMS, rows);
  const query = new Float32Array(STORE_DIMS);
  query.set(fixture.query);
  const got = (await scanCandidates(handle.duckdb, query, STORE_DIMS, 10)).map((hit) => `${hit.path}:${hit.similarity}`);
  const want = fixture.expected.map((hit) => `${hit.path}:${hit.similarity}`);
  return got.join(', ') === want.join(', ') ? null : `[${got.join(', ')}], expected [${want.join(', ')}]`;
}

// The sense-supplied scalar functions, registered on the connection that serves users' SQL.
export async function checkRegisteredFunctions(handle: DuckdbHandle, fixture = ENGINE_CHECK_FUNCTIONS): Promise<string | null> {
  await registerFunctions(handle.duckdb);
  for (const { sql, expected } of fixture) {
    const reader = await handle.duckdb.runAndReadAll(sql);
    const got = reader.getRowObjectsJS()[0].v;
    if (got !== expected) return `${JSON.stringify(got)} for ${sql}, expected ${JSON.stringify(expected)}`;
  }
  return null;
}

// The real schema, index build and lexical query over store/engine.ts's fixture, in memory, after the binding checks (cheap, no network) and before the fts extension install.
async function checkDuckdbEngine(): Promise<void> {
  const { api, version } = await duckdbNative();
  const instance = await api.DuckDBInstance.create(':memory:');
  const handle = { instance, duckdb: await instance.connect() };
  try {
    const conn = createConnection(handle.duckdb);
    await conn.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    await ensureCoreSchema(handle, conn);
    await conn.runBatch(
      'INSERT INTO content ("path", title, summary, text) VALUES (?, ?, ?, ?)',
      ENGINE_CHECK_DOCS.map((doc) => [doc.path, doc.title, doc.summary, doc.text])
    );
    const identity = engineIdentity(DUCKDB_PACKAGE, version);
    const remedy = npmRemedy(DUCKDB_PACKAGE, peerRange(DUCKDB_PACKAGE));
    await checkEngineStep('duckdb', identity, remedy, 'writing and reading VARIANT frontmatter', () => checkVariantColumns(handle, conn));
    await checkEngineStep('duckdb', identity, remedy, 'writing and scanning vectors', () => checkVectorScan(handle, conn));
    await checkEngineStep('duckdb', identity, remedy, 'calling the registered functions', () => checkRegisteredFunctions(handle));
    await runEngineCheck('duckdb', identity, remedy, async (terms) => {
      await prepareFts(conn);
      return (await queryLexical(conn, terms, { whereJoin: '', whereCond: '', scopeCond: '', limit: 10 })).map((hit) => hit.path);
    });
  } finally {
    await close(handle);
  }
}

// This store's dialect (types.ts's OpenDialect) for the shared orchestration in store/open.ts.
export const duckdbOpenDialect: OpenDialect<DuckdbHandle> = {
  filename: DB_FILENAME,
  schemaVersion: SCHEMA_VERSION,
  reconcileDialect: duckdbDialect,
  connect,
  close,
  // duckdb's file lock spans the connection's life, and each platform words the refusal its own
  // way: posix "Could not set lock on file ... Conflicting lock is held in <exe> (PID n)", Windows
  // "Cannot open file ... being used by another process". Both are the same condition.
  isLocked: (err) => /Could not set lock on file|being used by another process/.test(err.message),
  engineIdentity: duckdbEngineIdentity,
  checkEngine: checkDuckdbEngine,
  ensureCoreSchema,
  ensureFeatureSchema,
  prepareConnection,
  prepareLexical: prepareFts,
  assertLexicalReady: assertFtsReady,
  createStore: (handle, conn) => createStore(handle.instance, handle.duckdb, conn),
};

export async function openDuckdb(cfg: ResolvedConfig, options?: InternalOpenOptions): Promise<OpenResult> {
  return openWithDialect(cfg, duckdbOpenDialect, options);
}
