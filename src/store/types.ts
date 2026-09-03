// The backing-store interface: a minimal portable statement surface (exec/prepare), plus
// dedicated interfaces exactly where engines diverge (lexical index, vector scan, raw sql).

import type { Config, ResolvedConfig, StoreName } from '../config/index.ts';
import type { ReconcileDelta } from '../features/types.ts';
import type { ParsedDoc } from '../scan/index.ts';

// 'lexical'/'vectors': the store's LexicalIndex/VectorStore is functionally implemented, not
// present-but-inert. 'sql-functions': the engine can register has/basename/segment as UDFs at all,
// which turso's client cannot. The rest are finer FTS5-only behaviors; a missing one fails at open
// or first use. An array, not a bare union, so a runtime check reads the same list the type does.
export const CAPABILITY_NAMES = ['phrases', 'snippets', 'lexical', 'vectors', 'sql-functions'] as const;
export type Capability = (typeof CAPABILITY_NAMES)[number];

export interface RunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

// A prepared statement's async surface: every supported engine crosses a real async boundary
// for a query (DuckDB has no synchronous client), so run/get/all return Promises.
export interface Statement {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
  iterate(...params: unknown[]): AsyncIterable<unknown>;
  columns(): Array<{ name: string }>;
  setReadBigInts(enabled: boolean): void;
}

// Connection surface feature-owned SQL runs against inside a store's hot loops (schema,
// reconcile), portable so a feature never imports an engine-specific client type.
export interface Connection {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<Statement>;
  runBatch(sql: string, paramRows: unknown[][]): Promise<void>;
  // Bulk-inserts rows that cannot conflict, through a path that binds no per-value parameters.
  // Optional: a store that has nothing faster than its own INSERT omits it and callers fall back
  // (appendRows in shared.ts). `columns` names the values each row carries; a table column the
  // caller does not write takes its default.
  appendRows?(table: string, columns: string[], rows: unknown[][]): Promise<void>;
}

// One reconcile algorithm (src/store/reconcile.ts), parameterised per engine. reconcileContent is
// the load-bearing member: it lands every content-table change and owns its own multi-step
// strategy (sqlite FTS5 incremental, duckdb combined delete/insert, turso incremental-or-rebuild).
export interface ReconcileDialect {
  // BEGIN mode for the whole reconcile: sqlite/turso 'BEGIN IMMEDIATE', duckdb 'BEGIN'.
  beginMode(): string;
  // Throws SenseError('COLUMN_LIMIT', ...) past this store's own column ceiling and reasoning.
  checkColumnLimit(count: number): void;
  // Adds `names` to frontmatter, already filtered to columns this connection doesn't have yet.
  // sqlite/turso loop (their ADD COLUMN is metadata-only); duckdb issues one statement per call.
  addColumns(conn: Connection, names: string[]): Promise<void>;
  // Deletes content rows for `touched`, inserts rows for `docs`; `delta` carries the tree state a
  // strategy may need. Must not open its own transaction, and must not return before its own
  // multi-step strategy (e.g. turso's DROP/rebuild) completes.
  reconcileContent(conn: Connection, touched: string[], docs: ParsedDoc[], delta: ReconcileDelta, cfg: Config): Promise<void>;
  // Records this reconcile's write-transaction duration. sqlite/turso use it for open()'s derived
  // busy_timeout; duckdb has no such PRAGMA and omits it.
  recordDuration?(conn: Connection, ms: number): Promise<void>;
}

// One open algorithm (src/store/open.ts), parameterised per engine. `Handle` is whatever this
// store needs to close the connection and construct its Store (sqlite: {db}; duckdb:
// {instance, duckdb}; turso: db) -- opaque to the shared orchestration, threaded through unchanged.
export interface OpenDialect<Handle> {
  // Cache filename under STATE_DIR, e.g. 'cache.db'.
  filename: string;
  // Cache shape version, independent of the config's own `version`; bumping it rebuilds an existing tree.
  schemaVersion: string;
  reconcileDialect: ReconcileDialect;
  // Opens the physical connection and applies pragmas due before any SQL runs (sqlite: busy_timeout
  // + WAL; turso: connect-time timeout; duckdb: none).
  connect(dbPath: string, cfg: ResolvedConfig): Promise<{ handle: Handle; conn: Connection }>;
  // Releases the handle, for both the rebuild-and-reopen branch and error cleanup on this attempt.
  close(handle: Handle): Promise<void>;
  // True when connect() failed because another process holds the cache file, which the orchestration
  // retries. Each engine words it differently, so the match is the dialect's own (`native-not-emulated`).
  // Absent for sqlite, whose file lock is shared and whose concurrent-open failure is a different defect.
  // Matching on message text is forced, not chosen: measured 2026-09-02, duckdb throws a plain Error
  // whose only own properties are stack and message, and turso sets code to the constant
  // 'GenericFailure' on every failure alike with rawCode undefined. Neither exposes anything a
  // predicate could switch on, so each dialect pins its engine's wordings and unit-tests them.
  isLocked?(err: Error): boolean;
  // Schema DDL beyond frontmatter/preset_files/meta (content table, feature hooks); sole owner of
  // whether it wraps itself in a write transaction (sqlite: yes, guards a cold-open ALTER race; duckdb/turso: no).
  ensureSchema(handle: Handle, conn: Connection, cfg: Config): Promise<void>;
  // Installs the derived busy_timeout PRAGMA right before reconcile (sqlite/turso); absent for
  // duckdb, which has no such PRAGMA.
  setDerivedBusyTimeout?(handle: Handle, conn: Connection, ms: number): Promise<void>;
  createStore(handle: Handle, conn: Connection, cfg: ResolvedConfig): Store;
}

export interface FieldStat {
  field: string;
  coverage: number;
  type: string;
}

export interface DocumentStore {
  // Frontmatter column names (including internal ones; callers filter).
  columns(): Promise<string[]>;
  // Per-column coverage (non-null count) and observed type set, aggregated in one SQL query,
  // never one row per note. `scopeWhere` is a caller-built WHERE fragment, per LexicalQueryOptions.
  fieldStats(columns: string[], scopeWhere: string): Promise<FieldStat[]>;
}

export interface LexicalHit {
  path: string;
  hit: string | null;
}

export interface LexicalQueryOptions {
  whereJoin: string;
  whereCond: string;
  scopeCond: string;
  limit: number;
}

export interface LexicalIndex {
  // Ranked word-match query with excerpt, scoped by the caller-built SQL fragments (the same
  // fragments narrowByWhere/materializeScope produce elsewhere).
  query(terms: string, opts: LexicalQueryOptions): Promise<LexicalHit[]>;
}

export interface VectorCandidate {
  path: string;
  lines: string;
  similarity: number;
}

export interface VectorSimilar {
  path: string;
  similarity: number;
}

export interface VectorWriteRow {
  path: string;
  chunk: number;
  scale: number;
  vector: Buffer;
}

export interface VectorStore {
  // Rows whose vector is NULL: never embedded, or added since.
  pending(): Promise<Array<{ path: string; chunk: number }>>;
  // One batch write per call (never per row) so a provider's embedding batch stays inside a
  // single store method.
  writeVectors(rows: VectorWriteRow[]): Promise<void>;
  candidates(queryVector: Float32Array, storeDims: number, fetch: number, allowed?: Set<string>): Promise<VectorCandidate[]>;
  similar(path: string, opts: { exclude: Set<string>; allowed?: Set<string>; k: number }): Promise<VectorSimilar[]>;
  hasVector(path: string): Promise<boolean>;
}

// The `sense sql` passthrough: string in, streamed rows out. Each store registers the same
// sense-supplied functions and applies its own read-bigints/error-translation behavior.
export interface RawStatement {
  columns(): Array<{ name: string }>;
  iterate(...params: unknown[]): AsyncIterable<unknown>;
}

export interface SqlSession {
  prepare(sql: string): Promise<RawStatement>;
}

export interface Store {
  readonly name: StoreName;
  readonly capabilities: ReadonlySet<Capability>;
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<Statement>;
  // One crossing, N rows: every external write loop (search's candidate insert, graph ring's
  // temp-table writes) goes through this instead of looping over `run()`. Same contract as Connection.runBatch.
  runBatch(sql: string, paramRows: unknown[][]): Promise<void>;
  // Pins one snapshot across multi-statement reads; `map` and `peek` use it. A network-bound
  // write (search's embedding top-up) must stay outside it. Nesting joins the enclosing transaction.
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  docs: DocumentStore;
  lexical: LexicalIndex;
  vectors: VectorStore;
  raw: SqlSession;
  // Engine-level facts for `sense status` (e.g. a derived busy_timeout PRAGMA reading); each
  // store owns what it reports and how it is worded. Empty when there is nothing to report.
  engineStatus(): Promise<Record<string, string>>;
  close(): Promise<void>;
}
