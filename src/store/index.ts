// Rows -> a backing store: registry + the public open/build boundary. Parsing lives in scan.ts;
// everything beyond frontmatter + content lives in src/features/.

import type { ResolvedConfig, StoreName } from '../config/index.ts';
import { anyPresetEmbeds, storeName } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { clearCache } from './cache.ts';
import { DB_FILENAME as DUCKDB_FILENAME, openDuckdb } from './duckdb/open.ts';
import { CAPABILITIES as DUCKDB_CAPABILITIES } from './duckdb/store.ts';
import type { BuildRequirement, InternalOpenOptions, OpenOptions, OpenResult } from './open.ts';
import { openSqlite, DB_FILENAME as SQLITE_FILENAME } from './sqlite/open.ts';
import { CAPABILITIES as SQLITE_CAPABILITIES } from './sqlite/store.ts';
import type { Stages } from './stages.ts';
import { openTurso, DB_FILENAME as TURSO_FILENAME } from './turso/open.ts';
import { CAPABILITIES as TURSO_CAPABILITIES } from './turso/store.ts';
import type { Capability } from './types.ts';

interface StoreEntry {
  capabilities: ReadonlySet<Capability>;
  filename: string;
  open: (cfg: ResolvedConfig, options?: InternalOpenOptions) => Promise<OpenResult>;
}

const REGISTRY: Record<StoreName, StoreEntry> = {
  sqlite: { capabilities: SQLITE_CAPABILITIES, filename: SQLITE_FILENAME, open: openSqlite },
  duckdb: { capabilities: DUCKDB_CAPABILITIES, filename: DUCKDB_FILENAME, open: openDuckdb },
  turso: { capabilities: TURSO_CAPABILITIES, filename: TURSO_FILENAME, open: openTurso },
};

function entryFor(name: StoreName): StoreEntry {
  const entry = REGISTRY[name];
  if (!entry) throw new SenseError('STORE_UNKNOWN', `unknown backing store "${name}"; available: ${Object.keys(REGISTRY).join(', ')}`);
  return entry;
}

function requirementsFor(cfg: ResolvedConfig): Set<BuildRequirement> {
  const requirements = new Set<BuildRequirement>(['core', 'lexical']);
  if (anyPresetEmbeds(cfg)) requirements.add('vectors');
  return requirements;
}

function validateRequirements(cfg: ResolvedConfig, entry: StoreEntry, requirements: ReadonlySet<BuildRequirement>): void {
  if (requirements.has('vectors') && anyPresetEmbeds(cfg) && !entry.capabilities.has('vectors')) {
    const name = storeName(cfg);
    throw new SenseError('STORE_CAPABILITY_MISSING', `store "${name}" does not implement "vectors" in this build, but this config's "embed" block is in use by at least one preset; remove or narrow it, or set "store" to a store that supports vectors (sqlite)`);
  }
}

export async function openStoreFor(cfg: ResolvedConfig, options: InternalOpenOptions): Promise<OpenResult> {
  const entry = entryFor(storeName(cfg));
  validateRequirements(cfg, entry, options.requirements ?? new Set<BuildRequirement>(['core']));
  return entry.open(cfg, options);
}

export async function openStore(cfg: ResolvedConfig, options: OpenOptions = {}): Promise<OpenResult> {
  const buildEnabled = options.build !== false;
  return openStoreFor(cfg, {
    build: buildEnabled,
    requirements: buildEnabled ? requirementsFor(cfg) : new Set<BuildRequirement>(['core']),
  });
}

export async function lexicalReadiness(cfg: ResolvedConfig): Promise<{ ready: boolean; error: string | null }> {
  let opened: OpenResult;
  try {
    opened = await openStoreFor(cfg, { build: false, requirements: new Set<BuildRequirement>(['core', 'lexical']) });
  } catch (err) {
    if (err instanceof SenseError && err.code === 'INDEX_NOT_READY') return { ready: false, error: err.message };
    throw err;
  }
  try {
    return { ready: true, error: null };
  } finally {
    await opened.store.close();
  }
}

export interface BuildOptions {
  force?: boolean;
}

export interface BuildResult {
  cfg: ResolvedConfig;
  dbPath: string;
  parsed: number;
  warnings: string[];
  stages: Stages;
}

export async function buildIndex(cfg: ResolvedConfig, options: BuildOptions = {}): Promise<BuildResult> {
  if (options.force) clearCache(cfg);
  const opened = await openStoreFor(cfg, { build: true, requirements: requirementsFor(cfg) });
  try {
    const { store: _store, ...result } = opened;
    return result;
  } finally {
    await opened.store.close();
  }
}

export function storeFilename(cfg: ResolvedConfig): string {
  return entryFor(storeName(cfg)).filename;
}

export type { OpenOptions, OpenResult } from './open.ts';
export { docCount } from './open.ts';
export { getMeta, setMeta } from './shared.ts';
export { DB_FILENAME, SCHEMA_VERSION } from './sqlite/open.ts';
export type { Stages } from './stages.ts';
export type { Capability, Connection, DocumentStore, LexicalHit, LexicalIndex, LexicalQueryOptions, RawStatement, RunResult, SqlSession, Statement, Store, VectorCandidate, VectorSimilar, VectorStore, VectorWriteRow } from './types.ts';
export { CAPABILITY_NAMES } from './types.ts';
export { clearCache };
