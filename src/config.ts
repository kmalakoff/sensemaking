import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SenseError } from './errors.ts';

export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// Highest sense.config.json `version` this build understands. Older versions auto-migrate on load.
export const SUPPORTED_CONFIG_VERSION = 3;

// Each feature owns its tables, parse-time extraction, and reconcile step; commands degrade when one is off.
// links/sections/rank are opt-out toggles in the top-level `features` block; embed is not a
// member of that block -- it is derived from whether any declared preset has semantic on.
const FEATURE_NAMES = ['links', 'sections', 'rank', 'embed'] as const;
// v1 -> v2 migration only: the features v2 introduced as opt-out (embed was opt-in then).
const V2_OPT_OUT_NAMES = ['links', 'sections', 'rank'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

// `embed` config is provider settings only -- presence toggles nothing. Vector participation
// is controlled per preset by `semantic`.
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
  semantic?: boolean; // vectors on/off for files this preset covers. Default true; only ever written as false.
  where?: string; // standing SQL condition against frontmatter alias `f`
}

// A saved `search` invocation: `sense <name>` runs like
// `sense search <search> [--preset] [--include] [--where] [--k] [--semantic]`.
export interface SavedSearch {
  search: string;
  preset?: string;
  include?: string[];
  where?: string;
  k?: number;
  semantic?: boolean;
}

// A queries.<name> entry: raw SQL, an explicit SQL wrapper, or a saved search.
export type SavedQuery = string | { sql: string } | SavedSearch;

export interface Config {
  // Editor-only pointer to schema.json; never read by sense.
  $schema?: string;
  version?: number;
  // File selection, index-time, and per-preset search defaults. A file is indexed iff any
  // preset's include/exclude covers it (union); embedded iff any covering preset has
  // semantic !== false. `default` is used when a command names no preset.
  presets: Record<string, Preset>;
  // Global feature defaults; absent block or key means enabled. embed is not a member here --
  // see Preset.semantic.
  features?: { links?: boolean; sections?: boolean; rank?: boolean };
  // Embed provider settings only. Presence alone does not enable embedding -- see Preset.semantic.
  embed?: EmbedConfig;
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

export function presetNames(cfg: Config): string[] {
  return Object.keys(cfg.presets);
}

// A preset's own resolved vector participation: absent or true means on, false means off.
export function presetSemanticEnabled(cfg: Config, name: string): boolean {
  return cfg.presets[name]?.semantic !== false;
}

// Whether embedding needs to run at all: true when at least one declared preset wants vectors.
export function anyPresetEmbeds(cfg: Config): boolean {
  return presetNames(cfg).some((name) => presetSemanticEnabled(cfg, name));
}

// Opt-out features (default on): absent block or key means enabled. `rank` additionally
// requires `links`. `embed` is derived, not a features-block member: on iff any declared
// preset has semantic on.
export function featureEnabled(cfg: Config, name: FeatureName): boolean {
  if (name === 'embed') return anyPresetEmbeds(cfg);
  const enabled = cfg.features?.[name] !== false;
  if (name === 'rank') return enabled && featureEnabled(cfg, 'links');
  return enabled;
}

export function enabledFeatures(cfg: Config): FeatureName[] {
  return FEATURE_NAMES.filter((name) => featureEnabled(cfg, name));
}

// Every feature with its current state; commands surface this so "off" and "empty" stay
// distinguishable in output.
export function featureStates(cfg: Config): { on: FeatureName[]; off: FeatureName[] } {
  return {
    on: FEATURE_NAMES.filter((name) => featureEnabled(cfg, name)),
    off: FEATURE_NAMES.filter((name) => !featureEnabled(cfg, name)),
  };
}

// Resolved embed provider settings, or null when no preset wants embeddings at all.
export function embedConfig(cfg: Config): { model: string; type: 'static' | 'api'; url?: string; key?: string } | null {
  if (!anyPresetEmbeds(cfg)) return null;
  const e = cfg.embed ?? {};
  return { model: e.model ?? DEFAULT_EMBED_MODEL, type: e.type ?? 'static', url: e.url, key: e.key };
}

// Cache-key string: embed carries its type + model so a model change rebuilds like a toggle,
// and every declared preset carries its include/exclude/semantic so an edit to any of those
// rebuilds too -- indexing and embedding are both derived from presets, so any change to the
// derivation inputs must invalidate the cache.
export function featureSignature(cfg: Config): string {
  const globalPart = enabledFeatures(cfg)
    .filter((name) => name !== 'embed')
    .join(',');
  const e = embedConfig(cfg);
  const embedPart = e ? `embed:${e.type}:${e.model}` : 'embed:off';
  // One keyed segment per preset so a rebuild notice can name exactly which preset moved.
  const presetsPart = [...presetNames(cfg)]
    .sort()
    .map((name) => {
      const p = cfg.presets[name];
      const include = [...p.include].sort().join('+');
      const exclude = [...(p.exclude ?? [])].sort().join('+');
      return `preset:${name}:${include}:${exclude}:${p.semantic === false ? 'off' : 'on'}`;
    })
    .join('|');
  return [`features:${globalPart}`, embedPart, presetsPart].join('|');
}

// Looks up a declared preset by name, defaulting to `default`. Throws naming every declared
// preset when an explicit name is not declared -- the `default` fallback is never unknown
// itself (validateConfig requires it).
export function resolvePreset(cfg: Config, name?: string): { name: string; preset: Preset } {
  const presetName = name ?? 'default';
  const preset = cfg.presets[presetName];
  if (!preset) throw new SenseError('PRESET_UNKNOWN', `unknown preset "${presetName}"; declared presets: ${presetNames(cfg).join(', ')}`);
  return { name: presetName, preset };
}

export interface SearchOverrides {
  preset?: string;
  k?: number;
  where?: string;
  include?: string[];
  semantic?: boolean;
}

export interface EffectiveSearch {
  presetName: string;
  k: number;
  where?: string;
  include: string[];
  exclude?: string[];
  semantic: boolean;
}

// Resolution precedence: built-ins (k=10, semantic on, whole-index scope) <- named preset's
// fields (or `default` when none named) <- caller overrides. Each stage overrides only the
// fields it sets. `opts` here is expected to already carry whatever a saved query and an
// explicit CLI flag resolved between themselves (src/cli/named.ts does that `cli ?? saved`
// merge before calling in) -- one `??` per field composes the full four-stage chain, since
// `??` is associative field-by-field.
export function resolveSearch(cfg: Config, opts: SearchOverrides = {}): EffectiveSearch {
  const { name: presetName, preset } = resolvePreset(cfg, opts.preset);
  const k = opts.k ?? preset.k ?? 10;
  const where = opts.where ?? preset.where;
  // An explicit include (CLI --include, or a saved search's own `include`) is a full ad hoc
  // scope override -- it replaces the preset's include/exclude pair rather than layering on
  // top of it, the same "replaces, doesn't AND" rule --where already uses.
  const include = opts.include ?? preset.include;
  const exclude = opts.include ? undefined : preset.exclude;
  const semantic = opts.semantic !== undefined ? opts.semantic : preset.semantic !== false;
  return { presetName, k, where, include, exclude, semantic };
}

// Pure per-version steps; loadConfig chains them from the file's version up to SUPPORTED_CONFIG_VERSION.
// Intermediate shapes predate the current Config type (v1 has no features block, v2 has
// scan/find not presets/search), so steps work loosely-typed and only the final result is cast
// back to Config.
const MIGRATIONS: Record<number, (cfg: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 -> v2: features block introduced, opt-out features enabled (matches the old implicit
  // behavior of `links` etc. not existing). embed stays absent -- opt-in.
  1: (cfg) => ({ ...cfg, version: 2, features: Object.fromEntries(V2_OPT_OUT_NAMES.map((name) => [name, true])) }),
  // v2 -> v3: mechanical-minimal, by decision -- only what keeps an existing config loading.
  // No restructuring, no preset inference, no query rewriting; real trees get hand-migrated
  // separately to actually use presets.
  2: (cfg) => {
    const { scan, defaults, features, checks, queries, ...rest } = cfg;
    const scanInclude = (scan as { include: string[] }).include;

    const nextQueries: Record<string, unknown> = {};
    for (const [name, value] of Object.entries((queries as Record<string, unknown> | undefined) ?? {})) {
      if (typeof value === 'string') {
        nextQueries[name] = value;
        continue;
      }
      const entry = value as { find: string; k?: number; where?: string; semantic?: boolean };
      const search: SavedSearch = { search: entry.find };
      if (entry.k !== undefined) search.k = entry.k;
      if (entry.where !== undefined) search.where = entry.where;
      // semantic: true was opt-in; it is now the default, so it drops. semantic: false is kept.
      if (entry.semantic === false) search.semantic = false;
      nextQueries[name] = search;
    }

    const prevDefaults = defaults as { find?: { where?: string } } | undefined;
    const defaultWhere = prevDefaults?.find?.where;

    // features.embed: true/absent -> simply removed (v3 default is on). An explicit `false`
    // becomes semantic: false on every preset this migration produces -- there is only ever
    // one (`default`), since v2 has no notion of multiple scopes, but the rule is written to
    // apply to "every migrated preset" rather than hardcoded to `default` in case a later
    // migration step ever produces more than one.
    const prevFeatures = (features as Record<string, unknown> | undefined) ?? {};
    const embedWasOff = prevFeatures.embed === false;
    // Object form carried provider settings (model/type/url/key), not a toggle -- they move
    // to the v3 top-level `embed` block verbatim; dropping them would silently switch an
    // api tree back to the built-in static model.
    const embedProvider = typeof prevFeatures.embed === 'object' && prevFeatures.embed !== null ? prevFeatures.embed : undefined;
    const { embed: _embed, ...restFeatures } = prevFeatures;

    const defaultPreset: Record<string, unknown> = { include: scanInclude };
    if (defaultWhere !== undefined) defaultPreset.where = defaultWhere;
    if (embedWasOff) defaultPreset.semantic = false;

    // checks (assertions over saved queries) was removed in v3; its queries still run under
    // `queries`, just without the pass/fail assertion -- reachable now only as a saved query.
    if (checks !== undefined) {
      console.error('sense: v2 "checks" was removed in v3 (sense check no longer asserts on saved queries); its queries are carried over under "queries" -- a returned row set is now the reader\'s judgment');
    }

    const result: Record<string, unknown> = { ...rest, version: 3, presets: { default: defaultPreset }, queries: nextQueries };
    if (embedProvider !== undefined) result.embed = embedProvider;
    if (Object.keys(restFeatures).length > 0) result.features = restFeatures;
    return result;
  },
};

export function migrateConfig(cfg: Config): { cfg: Config; from: number } {
  const from = cfg.version ?? 1;
  let current: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let v = from; v < SUPPORTED_CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `no migration from config version ${v}`);
    current = step(current);
  }
  return { cfg: current as unknown as Config, from };
}

function starterConfig(): Config {
  return {
    $schema: 'https://unpkg.com/sensemaking/schema.json',
    version: SUPPORTED_CONFIG_VERSION,
    presets: {
      default: { include: ['**/*.md'], k: 10 },
      large: { include: ['**/*.md'], k: 20 },
    },
    queries: {},
  };
}

// Refuses to overwrite an existing config.
export function initConfig(dir: string): string {
  const configPath = join(dir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    throw new SenseError('CONFIG_EXISTS', `${CONFIG_FILENAME} already exists in ${dir}`);
  }
  writeFileSync(configPath, `${JSON.stringify(starterConfig(), null, 2)}\n`);
  return configPath;
}

export function findConfigPath(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Shape check for hand-edited files: a typo'd config fails with a named error, not a
// TypeError from whatever code touched the missing field first. `queries` is optional
// on disk (absent = none); `presets` has no usable default.
// Unknown top-level keys are reported as a soft warning (cli.ts prints it) rather than an
// error, so a config carrying a stray field still runs -- but unknown keys inside a preset,
// features, embed, or saved-query block are hard errors: those blocks are small and fully
// owned, so a typo there is far more likely a mistake than a forward-compat field.
const KNOWN_KEYS = new Set(['$schema', 'version', 'presets', 'features', 'embed', 'queries']);
const KNOWN_PRESET_KEYS = new Set(['include', 'exclude', 'k', 'semantic', 'where']);
const KNOWN_FEATURE_KEYS = new Set(['links', 'sections', 'rank']);
const KNOWN_EMBED_KEYS = new Set(['model', 'type', 'url', 'key']);
const SAVED_SEARCH_KEYS = new Set(['search', 'preset', 'include', 'where', 'k', 'semantic']);

function unknownConfigKeys(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((g) => typeof g === 'string' && g.length > 0);
}

// Pre-v3 shape check, just enough for migrateConfig to run safely (it reads scan.include
// directly). The full v3 shape is checked by validateConfig once migration has produced it.
function validateLegacyScan(parsed: unknown, configPath: string): void {
  const cfg = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const scan = cfg?.scan as { include?: unknown } | undefined;
  if (!cfg || !scan || !isNonEmptyStringArray(scan.include)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: scan.include must be a non-empty array of glob strings`);
  }
}

function validateFeaturesBlock(value: unknown, configPath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: features must be an object of name -> boolean`);
  }
  const block = value as Record<string, unknown>;
  const unknown = Object.keys(block).filter((k) => !KNOWN_FEATURE_KEYS.has(k));
  if (unknown.length > 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: features has unknown key(s) ${unknown.join(', ')}; embed is not a features key -- see the top-level "embed" block and each preset's "semantic"`);
  }
  for (const [name, v] of Object.entries(block)) {
    if (typeof v !== 'boolean') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: features.${name} must be a boolean`);
    }
  }
}

function validateEmbedBlock(value: unknown, configPath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed must be an object of { model?, type?: "static"|"api", url?, key? }`);
  }
  const embed = value as Record<string, unknown>;
  const unknown = Object.keys(embed).filter((k) => !KNOWN_EMBED_KEYS.has(k));
  if (unknown.length > 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed has unknown key(s) ${unknown.join(', ')}`);
  }
  if (embed.model !== undefined && typeof embed.model !== 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed.model must be a string`);
  }
  if (embed.type !== undefined && embed.type !== 'static' && embed.type !== 'api') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed.type must be "static" or "api"`);
  }
  if (embed.url !== undefined && typeof embed.url !== 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed.url must be a string`);
  }
  if (embed.key !== undefined && typeof embed.key !== 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed.key must be a string`);
  }
}

function validatePreset(name: string, value: unknown, configPath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name} must be an object`);
  }
  const preset = value as Record<string, unknown>;
  const unknown = Object.keys(preset).filter((k) => !KNOWN_PRESET_KEYS.has(k));
  if (unknown.length > 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name} has unknown key(s) ${unknown.join(', ')}; a preset takes include, exclude, k, semantic, where`);
  }
  if (!isNonEmptyStringArray(preset.include)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.include must be a non-empty array of glob strings`);
  }
  if (preset.exclude !== undefined && !isNonEmptyStringArray(preset.exclude)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.exclude must be a non-empty array of glob strings`);
  }
  if (preset.k !== undefined && (typeof preset.k !== 'number' || !Number.isInteger(preset.k) || preset.k <= 0)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.k must be a positive integer`);
  }
  if (preset.semantic !== undefined && typeof preset.semantic !== 'boolean') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.semantic must be a boolean`);
  }
  if (preset.where !== undefined && typeof preset.where !== 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.where must be a SQL condition string`);
  }
}

// A queries.<name> entry: a SQL string, { sql }, or a saved search { search, preset?, include?, where?, k?, semantic? }.
function validateSavedQuery(name: string, value: unknown, configPath: string): void {
  if (typeof value === 'string') return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} must be a SQL string, { sql }, or { search, preset?, include?, where?, k?, semantic? }`);
  }
  const entry = value as Record<string, unknown>;
  if ('sql' in entry) {
    const unknown = Object.keys(entry).filter((k) => k !== 'sql');
    if (unknown.length > 0) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} has unknown key(s) ${unknown.join(', ')}; a { sql } query takes only sql`);
    }
    if (typeof entry.sql !== 'string' || entry.sql.trim() === '') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.sql must be a non-empty string`);
    }
    return;
  }
  if ('search' in entry) {
    const unknown = Object.keys(entry).filter((k) => !SAVED_SEARCH_KEYS.has(k));
    if (unknown.length > 0) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} has unknown key(s) ${unknown.join(', ')}; a saved search takes search, preset, include, where, k, semantic`);
    }
    // A saved query saves a question; a scope without a question is just flags.
    if (typeof entry.search !== 'string' || entry.search.trim() === '') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.search must be non-empty text`);
    }
    if (entry.preset !== undefined && (typeof entry.preset !== 'string' || entry.preset.length === 0)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.preset must be a preset name`);
    }
    if (entry.include !== undefined && !isNonEmptyStringArray(entry.include)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.include must be a non-empty array of glob strings`);
    }
    if (entry.where !== undefined && typeof entry.where !== 'string') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.where must be a SQL condition string`);
    }
    if (entry.k !== undefined && (typeof entry.k !== 'number' || !Number.isInteger(entry.k) || entry.k <= 0)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.k must be a positive integer`);
    }
    if (entry.semantic !== undefined && typeof entry.semantic !== 'boolean') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.semantic must be a boolean`);
    }
    return;
  }
  throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} must be a SQL string, { sql }, or { search, preset?, include?, where?, k?, semantic? }`);
}

function validateConfig(parsed: unknown, configPath: string): Config {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: config must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;

  // `checks` (assertions over saved queries) was removed in v3, not merely deprecated: a
  // hand-written v3 config still carrying it gets a named rejection rather than a silent
  // "unknown key" warning, since silence here would hide that the assertion behavior it
  // implies no longer exists.
  if (cfg.checks !== undefined) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: checks was removed in v3 -- sense check no longer asserts on saved queries; a returned row set is the reader's judgment`);
  }

  const presets = cfg.presets as Record<string, unknown> | undefined;
  if (!presets || typeof presets !== 'object' || Array.isArray(presets) || Object.keys(presets).length === 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets must be a non-empty object of preset name -> { include, exclude?, k?, semantic?, where? }`);
  }
  for (const [name, value] of Object.entries(presets)) {
    validatePreset(name, value, configPath);
  }
  if (presets.default === undefined) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets must include a "default" preset`);
  }

  if (cfg.queries === undefined) cfg.queries = {};
  if (typeof cfg.queries !== 'object' || cfg.queries === null || Array.isArray(cfg.queries)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries must be an object of name -> SQL string, { sql }, or saved search`);
  }
  const queries = cfg.queries as Record<string, unknown>;
  for (const [name, value] of Object.entries(queries)) {
    validateSavedQuery(name, value, configPath);
  }

  if (cfg.features !== undefined) {
    validateFeaturesBlock(cfg.features, configPath);
  }
  if (cfg.embed !== undefined) {
    validateEmbedBlock(cfg.embed, configPath);
  }

  return cfg as unknown as Config;
}

export function loadConfig(explicitPath?: string): ResolvedConfig {
  let configPath: string;
  if (explicitPath) {
    configPath = resolve(process.cwd(), explicitPath);
    if (!existsSync(configPath)) throw new SenseError('CONFIG_NOT_FOUND', `config not found: ${configPath}`);
  } else {
    const found = findConfigPath(process.cwd());
    if (!found) {
      throw new SenseError('CONFIG_NOT_FOUND', `could not find ${CONFIG_FILENAME} in ${process.cwd()} or any parent directory`);
    }
    configPath = found;
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);

  // Ahead of both the version gate and legacy/current shape checks: a non-object file (or
  // an array -- typeof [] is also 'object') is malformed at every version, so it gets one
  // error regardless of which branch would otherwise run.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: config must be a JSON object`);
  }

  // Version gate before shape validation: a config written by a newer sense should fail
  // with "requires a newer sense", not with shape errors its own version may not have.
  const version = typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'number' ? (parsed as { version: number }).version : 1;
  if (version > SUPPORTED_CONFIG_VERSION) {
    throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `config version ${version} requires a newer sense`);
  }

  // validateConfig only understands the current v3 shape (presets, saved-query object
  // shapes); a pre-v3 file on disk is scan/find-shaped and must migrate before it can pass
  // that check. Validate just enough of the old shape to migrate safely, migrate, then run
  // the full v3 validateConfig on the migrated result -- the shape that actually lands on
  // disk and in ResolvedConfig.
  let cfg: Config;
  let migratedFrom: number | undefined;
  if (version < SUPPORTED_CONFIG_VERSION) {
    validateLegacyScan(parsed, configPath);
    const result = migrateConfig(parsed as unknown as Config);
    cfg = validateConfig(result.cfg, configPath);
    migratedFrom = result.from;
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  } else {
    cfg = validateConfig(parsed, configPath);
  }

  const unknownKeys = unknownConfigKeys(cfg as unknown as Record<string, unknown>);
  return { ...cfg, baseDir: dirname(configPath), configPath, migratedFrom, unknownKeys: unknownKeys.length > 0 ? unknownKeys : undefined };
}
