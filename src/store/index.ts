// Rows -> a backing store: registry + openStore(cfg). Parsing lives in scan.ts; everything
// beyond frontmatter + content lives in src/features/.

import type { ResolvedConfig } from '../config/index.ts';
import { anyPresetEmbeds, storeName } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { openDuckdb } from './duckdb/open.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from './duckdb/store.ts';
import type { OpenResult } from './sqlite/open.ts';
import { openSqlite } from './sqlite/open.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from './sqlite/store.ts';
import type { Capability } from './types.ts';

type StoreName = 'sqlite' | 'duckdb';

interface StoreEntry {
  capabilities: ReadonlySet<Capability>;
  open: (cfg: ResolvedConfig) => Promise<OpenResult>;
}

// Capabilities are checked against the registry entry before opening (no wasted connect/reconcile
// work for a config that cannot be satisfied), then the store itself opens.
const REGISTRY: Record<StoreName, StoreEntry> = {
  sqlite: { capabilities: SQLITE_CAPABILITIES, open: openSqlite },
  duckdb: { capabilities: DUCKDB_CAPABILITIES, open: openDuckdb },
};

function entryFor(name: StoreName): StoreEntry {
  const entry = REGISTRY[name];
  if (!entry) throw new SenseError('STORE_UNKNOWN', `unknown backing store "${name}"; available: ${Object.keys(REGISTRY).join(', ')}`);
  return entry;
}

export async function openStore(cfg: ResolvedConfig): Promise<OpenResult> {
  const name = storeName(cfg);
  const entry = entryFor(name);

  // The one unambiguous, config-level capability need: an embed block some preset actually
  // uses for vectors. Word/lexical search has no equivalent unambiguous signal at this level
  // (every preset defaults to wanting "words"), so a store lacking 'lexical' fails loudly at
  // first use instead (see duckdb/store.ts's lexical.query()).
  if (anyPresetEmbeds(cfg) && !entry.capabilities.has('vectors')) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "vectors" in this build, but this config's "embed" block is in use by at least one preset; remove or narrow it, or set "store" to a store that supports vectors (sqlite)`);
  }

  return entry.open(cfg);
}

// watch keeps its connection open for the run, so a file-locking store would fail every
// other command on the tree; check before open, as openStore does for "vectors".
export function requireWatchConcurrency(cfg: ResolvedConfig): void {
  const name = storeName(cfg);
  if (!entryFor(name).capabilities.has('watch-concurrency')) {
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "watch-concurrency" in this build; sense watch holds the store open for its whole run, and this store locks the cache file, so every other command on this tree would fail to open; set "store" to "sqlite" in sense.config.json`);
  }
}

export { getMeta, setMeta } from './meta.ts';
export type { OpenResult } from './sqlite/open.ts';
export { clearCache, DB_FILENAME, docCount, SCHEMA_VERSION } from './sqlite/open.ts';
export type { Capability, Connection, DocumentStore, LexicalHit, LexicalIndex, LexicalQueryOptions, RawStatement, RunResult, SqlSession, Statement, Store, VectorCandidate, VectorSimilar, VectorStore, VectorWriteRow } from './types.ts';
