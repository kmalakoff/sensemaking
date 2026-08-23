import { SenseError } from '../errors.ts';
import type { Config } from './types.ts';

// Shape check for hand-edited files, so a typo names itself instead of surfacing as a
// TypeError. Unknown top-level keys warn (forward compat); unknown keys inside a block error.
const KNOWN_KEYS = new Set(['$schema', 'version', 'presets', 'features', 'embed', 'content', 'queries']);
const KNOWN_PRESET_KEYS = new Set(['include', 'exclude', 'k', 'semantic', 'where']);
const KNOWN_FEATURE_KEYS = new Set(['links', 'sections', 'tags', 'rank']);
const KNOWN_EMBED_KEYS = new Set(['model', 'type', 'url', 'key']);
const KNOWN_CONTENT_KEYS = new Set(['tokenize']);
const SAVED_SEARCH_KEYS = new Set(['search', 'preset', 'include', 'exclude', 'where', 'k']);

export function unknownConfigKeys(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg).filter((k) => !KNOWN_KEYS.has(k));
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((g) => typeof g === 'string' && g.length > 0);
}

// Pre-v3 shape check, just enough for migrateConfig to run safely (it reads scan.include
// directly). The full v3 shape is checked by validateConfig once migration has produced it.
export function validateLegacyScan(parsed: unknown, configPath: string): void {
  const cfg = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const scan = cfg?.scan as { include?: unknown } | undefined;
  if (!cfg || !scan || !isNonEmptyStringArray(scan.include)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: scan.include must be a non-empty array of glob strings`);
  }
}

// Only the shape is checked here. Whether the linked SQLite accepts the tokenizer is settled
// by probing it in db.ts, so this never has to carry a table of which version added what.
function validateContentBlock(value: unknown, configPath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: content must be an object of { tokenize?: string }`);
  }
  const block = value as Record<string, unknown>;
  const unknown = Object.keys(block).filter((k) => !KNOWN_CONTENT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: content has unknown key(s) ${unknown.join(', ')}; content takes tokenize`);
  }
  if (block.tokenize !== undefined && (typeof block.tokenize !== 'string' || block.tokenize.trim() === '')) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: content.tokenize must be a non-empty string, e.g. "trigram" or "unicode61 tokenchars '-_'"`);
  }
}

function validateFeaturesBlock(value: unknown, configPath: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: features must be an object of name -> boolean`);
  }
  const block = value as Record<string, unknown>;
  const unknown = Object.keys(block).filter((k) => !KNOWN_FEATURE_KEYS.has(k));
  if (unknown.length > 0) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: features has unknown key(s) ${unknown.join(', ')}; embed is not a features key -- see the top-level "embed" block`);
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
  // The block exists to name a model; provider settings without one would read as "vectors
  // configured" while embedding stays off, which is the ambiguity v4 removed.
  if (embed.model === undefined || embed.model === '') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: embed.model is required when the "embed" block is present (it is what turns vectors on); remove the block to index without vectors`);
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
  if (preset.semantic !== undefined && typeof preset.semantic !== 'boolean') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.semantic must be a boolean`);
  }
  if (preset.k !== undefined && (typeof preset.k !== 'number' || !Number.isInteger(preset.k) || preset.k <= 0)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.k must be a positive integer`);
  }
  if (preset.where !== undefined && typeof preset.where !== 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: presets.${name}.where must be a SQL condition string`);
  }
}

// A queries.<name> entry: { sql } or a saved search { search, preset?, include?, exclude?, where?, k? }.
function validateSavedQuery(name: string, value: unknown, configPath: string): void {
  // A bare string used to mean SQL. It now fails rather than being inferred: an entry says
  // which of the two verbs it runs, the same choice the CLI makes explicit.
  if (typeof value === 'string') {
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} must say which verb it runs: { "sql": ${JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value)} } to run it as SQL, or { "search": "..." } for a ranked search`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} must be { sql } or { search, preset?, include?, exclude?, where?, k? }`);
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
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} has unknown key(s) ${unknown.join(', ')}; a saved search takes search, preset, include, exclude, where, k`);
    }
    // A saved entry saves a question; a scope without a question is just flags.
    if (typeof entry.search !== 'string' || entry.search.trim() === '') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.search must be non-empty text`);
    }
    if (entry.preset !== undefined && (typeof entry.preset !== 'string' || entry.preset.length === 0)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.preset must be a preset name`);
    }
    if (entry.include !== undefined && !isNonEmptyStringArray(entry.include)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.include must be a non-empty array of glob strings`);
    }
    if (entry.exclude !== undefined && !isNonEmptyStringArray(entry.exclude)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.exclude must be a non-empty array of glob strings`);
    }
    if (entry.where !== undefined && typeof entry.where !== 'string') {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.where must be a SQL condition string`);
    }
    if (entry.k !== undefined && (typeof entry.k !== 'number' || !Number.isInteger(entry.k) || entry.k <= 0)) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name}.k must be a positive integer`);
    }
    return;
  }
  throw new SenseError('CONFIG_INVALID', `${configPath}: queries.${name} must be { sql } or { search, preset?, include?, exclude?, where?, k? }`);
}

export function validateConfig(parsed: unknown, configPath: string): Config {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: config must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;

  // `checks` is rejected by name, not warned: silence would hide that assertions are gone.
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
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries must be an object of name -> { sql } or { search }`);
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
  if (cfg.content !== undefined) {
    validateContentBlock(cfg.content, configPath);
  }

  return cfg as unknown as Config;
}
