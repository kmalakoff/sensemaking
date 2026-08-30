// The backing-store interface: a minimal portable statement surface (exec/prepare), plus
// dedicated interfaces exactly where engines diverge (lexical index, vector scan, raw sql).

import type { StoreName } from '../config/index.ts';

// 'lexical'/'vectors': the store's LexicalIndex/VectorStore is functionally implemented, not
// present-but-inert. The rest are finer FTS5-only behaviors; a missing one fails at open or first use.
export type Capability = 'phrases' | 'snippets' | 'watch-concurrency' | 'lexical' | 'vectors';

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
  // The whole file-sync pass (parse changed files, run every feature hook, resolve links,
  // recompute rank) behind one method: per-file iteration never crosses the async boundary.
  reconcile(): Promise<{ parsed: number; warnings: string[] }>;
  docs: DocumentStore;
  lexical: LexicalIndex;
  vectors: VectorStore;
  raw: SqlSession;
  // Engine-level facts for `sense status` (e.g. a derived busy_timeout PRAGMA reading); each
  // store owns what it reports and how it is worded. Empty when there is nothing to report.
  engineStatus(): Promise<Record<string, string>>;
  close(): Promise<void>;
}
