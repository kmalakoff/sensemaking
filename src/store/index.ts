// Rows -> a backing store: registry + openStore(cfg). Parsing lives in scan.ts; everything
// beyond frontmatter + content lives in src/features/.

import type { ResolvedConfig, StoreName } from '../config/index.ts';
import { anyPresetEmbeds, storeName } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import type { Builder } from './builder.ts';
import { duckdbOpenDialect, openDuckdb } from './duckdb/open.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from './duckdb/store.ts';
import type { OpenResult } from './open.ts';
import { openWithBuilder } from './open.ts';
import { openSqlite, sqliteOpenDialect } from './sqlite/open.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from './sqlite/store.ts';
import { openTurso, tursoOpenDialect } from './turso/open.ts';
import { CAPABILITIES as TURSO_CAPABILITIES } from './turso/store.ts';
import type { Capability } from './types.ts';

interface StoreEntry {
  capabilities: ReadonlySet<Capability>;
  open: (cfg: ResolvedConfig) => Promise<OpenResult>;
  // Same open, but keeps the builder's parse pool alive and hands it back: only a watcher, which
  // reconciles repeatedly on the same connection, needs this.
  openForWatch: (cfg: ResolvedConfig) => Promise<OpenResult & { builder: Builder }>;
}

// Capabilities are checked against the registry entry before opening (no wasted connect/reconcile
// work for a config that cannot be satisfied), then the store itself opens.
const REGISTRY: Record<StoreName, StoreEntry> = {
  sqlite: { capabilities: SQLITE_CAPABILITIES, open: openSqlite, openForWatch: (cfg) => openWithBuilder(cfg, sqliteOpenDialect) },
  duckdb: { capabilities: DUCKDB_CAPABILITIES, open: openDuckdb, openForWatch: (cfg) => openWithBuilder(cfg, duckdbOpenDialect) },
  turso: { capabilities: TURSO_CAPABILITIES, open: openTurso, openForWatch: (cfg) => openWithBuilder(cfg, tursoOpenDialect) },
};

function entryFor(name: StoreName): StoreEntry {
  const entry = REGISTRY[name];
  if (!entry) throw new SenseError('STORE_UNKNOWN', `unknown backing store "${name}"; available: ${Object.keys(REGISTRY).join(', ')}`);
  return entry;
}

export async function openStore(cfg: ResolvedConfig): Promise<OpenResult> {
  const name = storeName(cfg);
  const entry = entryFor(name);

  // The one unambiguous, config-level capability need: an embed block some preset actually uses
  // for vectors. Lexical search has no such signal at this level (every preset defaults to "words"), so a store lacking it fails loudly at first use.
  if (anyPresetEmbeds(cfg) && !entry.capabilities.has('vectors')) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "vectors" in this build, but this config's "embed" block is in use by at least one preset; remove or narrow it, or set "store" to a store that supports vectors (sqlite)`);
  }

  return entry.open(cfg);
}

// Same capability-checked open as openStore, but for a caller (only src/watch.ts) that must
// reconcile again later: keeps the builder's pool warm and hands it back instead of closing it.
export async function openStoreForWatch(cfg: ResolvedConfig): Promise<OpenResult & { builder: Builder }> {
  const name = storeName(cfg);
  const entry = entryFor(name);

  if (anyPresetEmbeds(cfg) && !entry.capabilities.has('vectors')) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "vectors" in this build, but this config's "embed" block is in use by at least one preset; remove or narrow it, or set "store" to a store that supports vectors (sqlite)`);
  }

  return entry.openForWatch(cfg);
}

// watch keeps its connection open for the run, so a file-locking store would fail every
// other command on the tree; check before open, as openStore does for "vectors".
export function requireWatchConcurrency(cfg: ResolvedConfig): void {
  const name = storeName(cfg);
  if (!entryFor(name).capabilities.has('watch-concurrency')) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "watch-concurrency" in this build; sense watch holds the store open for its whole run, and this store locks the cache file, so every other command on this tree would fail to open; set "store" to "sqlite" in sense.config.json`);
  }
}

export { clearCache } from './cache.ts';
export type { OpenResult } from './open.ts';
export { docCount } from './open.ts';
export { getMeta, setMeta } from './shared.ts';
export { DB_FILENAME, SCHEMA_VERSION } from './sqlite/open.ts';
export type { Stages } from './stages.ts';
export type { Capability, Connection, DocumentStore, LexicalHit, LexicalIndex, LexicalQueryOptions, RawStatement, RunResult, SqlSession, Statement, Store, VectorCandidate, VectorSimilar, VectorStore, VectorWriteRow } from './types.ts';
export { CAPABILITY_NAMES } from './types.ts';
