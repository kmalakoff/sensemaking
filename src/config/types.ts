import type { SignalWeights } from './signals.ts';

export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// Highest sense.config.json `version` this build understands. Older versions auto-migrate on load.
export const SUPPORTED_CONFIG_VERSION = 5;

// Each feature owns its tables, parse-time extraction, and reconcile step; commands degrade when one is off.
// links/sections/tags/rank are opt-out toggles in `features`; embed is on exactly when an `embed` block names a model.
export const FEATURE_NAMES = ['links', 'sections', 'tags', 'rank', 'embed'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

// `embed` names the model and gives the tree vectors at all; a preset's `signals` says which
// engines that scope's searches use.
export interface EmbedConfig {
  model?: string;
  provider?: 'static' | 'openai' | 'cohere';
  url?: string; // openai provider: OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  key?: string; // openai/cohere provider: name of the env var holding the bearer token, if any
  languages?: string[]; // owner-declared model languages; enables the language-fit check where no card exists
  chunkTokens?: number; // chunk size ceiling in estimated tokens for small-context models; default 500
}

export const DEFAULT_EMBED_MODEL = 'minishlab/potion-retrieval-32M';

// The single declaration every other store name derives from (Store.name, the store/index.ts
// registry, validate.ts's accepted set). An array, not a bare union, so runtime checks read the same list.
export const STORE_NAMES = ['sqlite', 'duckdb', 'turso'] as const;
export type StoreName = (typeof STORE_NAMES)[number];

// A named, self-contained file-selection scope: include/exclude are globby patterns resolved
// relative to the config file. No inheritance between presets; they may overlap freely (views, not partitions).
export interface Preset {
  include: string[];
  exclude?: string[];
  k?: number; // result count for `search` scoped to this preset; default 10
  // Exhaustive when present: every signal this preset's searches compose, each mapped to its RRF
  // weight (finite > 0; presence is enablement). Absent = every signal whose prerequisite holds, at weight 1 (words always, links when on, vectors when a model is named).
  signals?: SignalWeights;
  where?: string; // standing SQL condition against frontmatter alias `f`
}

// A saved `search` invocation: `sense <name>` runs like
// `sense search <search> [--preset] [--include] [--exclude] [--where] [--k]`.
export interface SavedSearch {
  search: string;
  preset?: string;
  include?: string[];
  exclude?: string[];
  where?: string;
  k?: number;
}

// An entry names the verb it runs, one to one with the commands: { sql } runs like
// `sense sql`, { search } like `sense search`.
export type SavedQuery = { sql: string } | SavedSearch;

export interface Config {
  // Editor-only pointer to schema.json; never read by sense.
  $schema?: string;
  version?: number;
  // File selection, index-time, and per-preset search defaults. A file is indexed iff any
  // preset's include/exclude covers it (union). `default` is used when a command names no preset.
  presets: Record<string, Preset>;
  // Global feature defaults; absent block or key means enabled. embed is not a member here --
  // see the `embed` block.
  features?: { links?: boolean; sections?: boolean; tags?: boolean; rank?: boolean };
  // Names the embedding model. Present means every indexed file gets vectors; absent means none do.
  embed?: EmbedConfig;
  // Backing store engine: "sqlite" (default, zero-dependency), "duckdb", or "turso" (optional
  // dependency, installed on first use). What differs per store is declared through CAPABILITIES (store/types.ts).
  store?: StoreName;
  queries: Record<string, SavedQuery>;
}

export interface ResolvedConfig extends Config {
  baseDir: string;
  configPath: string | null;
  // Keys the file declares that this build does not read; cli reports them.
  unknownKeys?: string[];
  // Set when loadConfig auto-migrated the file on disk; cli reports it.
  migratedFrom?: number;
}

export interface SearchOverrides {
  preset?: string;
  k?: number;
  where?: string;
  include?: string[];
  exclude?: string[];
  noExclude?: boolean; // drop the preset's exclude for this command; --exclude still applies
}

export interface EffectiveSearch {
  presetName: string;
  k: number;
  where?: string;
  include: string[];
  exclude?: string[];
  signals: SignalWeights; // this preset's effective signal weights
}
