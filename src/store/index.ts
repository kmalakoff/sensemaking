// Rows -> a backing store: registry + openStore(cfg). Parsing lives in scan.ts; everything
// beyond frontmatter + content lives in src/features/.

import type { ResolvedConfig, StoreName } from '../config/index.ts';
import { anyPresetEmbeds, storeName } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { openDuckdb } from './duckdb/open.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from './duckdb/store.ts';
import type { OpenResult } from './open.ts';
import { openSqlite } from './sqlite/open.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from './sqlite/store.ts';
import { openTurso } from './turso/open.ts';
import { CAPABILITIES as TURSO_CAPABILITIES } from './turso/store.ts';
import type { Capability } from './types.ts';

interface StoreEntry {
  capabilities: ReadonlySet<Capability>;
  open: (cfg: ResolvedConfig) => Promise<OpenResult>;
}

// Capabilities are checked against the registry entry before opening (no wasted connect/reconcile
// work for a config that cannot be satisfied), then the store itself opens.
const REGISTRY: Record<StoreName, StoreEntry> = {
  sqlite: { capabilities: SQLITE_CAPABILITIES, open: openSqlite },
  duckdb: { capabilities: DUCKDB_CAPABILITIES, open: openDuckdb },
  turso: { capabilities: TURSO_CAPABILITIES, open: openTurso },
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

export { clearCache } from './cache.ts';
export type { OpenResult } from './open.ts';
export { docCount } from './open.ts';
export { getMeta, setMeta } from './shared.ts';
export { DB_FILENAME, SCHEMA_VERSION } from './sqlite/open.ts';
export type { Stages } from './stages.ts';
export type { Capability, Connection, DocumentStore, LexicalHit, LexicalIndex, LexicalQueryOptions, RawStatement, RunResult, SqlSession, Statement, Store, VectorCandidate, VectorSimilar, VectorStore, VectorWriteRow } from './types.ts';
export { CAPABILITY_NAMES } from './types.ts';
