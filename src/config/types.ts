export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// Highest sense.config.json `version` this build understands. Older versions auto-migrate on load.
export const SUPPORTED_CONFIG_VERSION = 4;

// Each feature owns its tables, parse-time extraction, and reconcile step; commands degrade when one is off.
// links/sections/rank are opt-out toggles in the top-level `features` block; embed is not a
// member of that block -- it is on exactly when an `embed` block names a model.
export const FEATURE_NAMES = ['links', 'sections', 'rank', 'embed'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

// `embed` names the model and gives the tree vectors at all; a preset's `semantic` says
// whether that scope uses them.
export interface EmbedConfig {
  model?: string;
  type?: 'static' | 'api';
  url?: string; // api type: OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  key?: string; // api type: name of the env var holding the bearer token, if any
}

export const DEFAULT_EMBED_MODEL = 'minishlab/potion-retrieval-32M';

// A named, self-contained file-selection scope. include/exclude are globby patterns resolved
// relative to the config file. No inheritance between presets -- every field a preset wants
// it declares itself. Presets may overlap freely; they are views, not partitions.
export interface Preset {
  include: string[];
  exclude?: string[];
  k?: number; // result count for `search` scoped to this preset; default 10
  // Vectors for the files this preset covers, and for searches scoped to it. Default true;
  // only ever written as false. A layer searched for exact wording (ingested sources,
  // archives, generated output) sets it false and costs no embedding at all.
  semantic?: boolean;
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
  features?: { links?: boolean; sections?: boolean; rank?: boolean };
  // Names the embedding model. Present means every indexed file gets vectors; absent means none do.
  embed?: EmbedConfig;
  // Settings for the `content` FTS5 table. `tokenize` decides which languages the tree can be
  // word-searched in at all; changing it rebuilds the index.
  content?: { tokenize?: string };
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
  semantic: boolean; // the resolved preset's vector participation
}
