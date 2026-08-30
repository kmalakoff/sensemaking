import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SenseError } from '../errors.ts';
import { writeFileAtomic } from '../lib/atomic-write.ts';
import type { Config, ResolvedConfig } from './types.ts';
import { CONFIG_FILENAME, DEFAULT_EMBED_MODEL, SUPPORTED_CONFIG_VERSION } from './types.ts';
import { unknownConfigKeys, validateConfig, validateLegacyScan } from './validate.ts';

// v1 and v2 were `scan`/`find`-shaped; v3 introduced `presets`. Only the former need the
// legacy shape check before migrating.
const FIRST_PRESET_VERSION = 3;

// v1 -> v2 migration only: the features v2 introduced as opt-out (embed was opt-in then).
const V2_OPT_OUT_NAMES = ['links', 'sections', 'rank'] as const;

// Pure per-version steps, chained by loadConfig. Intermediate shapes predate the Config type,
// so steps are loosely typed and only the final result is cast back.
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
      // Loosely typed on purpose: this step emits the v3 shape, which still had `semantic`.
      // The v3 -> v4 step below strips it.
      const search: Record<string, unknown> = { search: entry.find };
      if (entry.k !== undefined) search.k = entry.k;
      if (entry.where !== undefined) search.where = entry.where;
      // semantic: true was opt-in; it is now the default, so it drops. semantic: false is kept.
      if (entry.semantic === false) search.semantic = false;
      nextQueries[name] = search;
    }

    const prevDefaults = defaults as { find?: { where?: string } } | undefined;
    const defaultWhere = prevDefaults?.find?.where;

    // features.embed false becomes semantic:false on every preset produced here.
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
  // v3 -> v4: write the model into the file, wrap bare-string queries as { sql }, drop a saved
  // search's `semantic` (its preset decides). Same effective model, so nothing re-embeds.
  3: (cfg) => {
    const presets = cfg.presets as Record<string, Record<string, unknown>>;
    const embedded = Object.values(presets).some((p) => p.semantic !== false);

    const nextQueries: Record<string, unknown> = {};
    for (const [name, value] of Object.entries((cfg.queries as Record<string, unknown> | undefined) ?? {})) {
      // v3's bare string meant SQL by inference; v4 makes every entry name its verb.
      if (typeof value === 'string') {
        nextQueries[name] = { sql: value };
        continue;
      }
      if (typeof value !== 'object' || value === null || !('search' in value)) {
        nextQueries[name] = value;
        continue;
      }
      const { semantic: _semantic, ...rest } = value as Record<string, unknown>;
      nextQueries[name] = rest;
    }

    const prev = (cfg.embed as Record<string, unknown> | undefined) ?? {};
    const result: Record<string, unknown> = { ...cfg, version: 4, queries: nextQueries };
    if (embedded) {
      result.embed = { model: (prev.model as string | undefined) ?? DEFAULT_EMBED_MODEL, type: (prev.type as string | undefined) ?? 'static', ...(prev.url !== undefined ? { url: prev.url } : {}), ...(prev.key !== undefined ? { key: prev.key } : {}) };
    } else {
      delete result.embed;
      // Dropping settings silently would look like a bug in a tree that had configured an
      // api endpoint and then turned vectors off; say it, since v4 has no way to carry
      // provider settings for a tree that does not embed.
      if (Object.keys(prev).length > 0) console.error('sense: every preset has "semantic": false, so v4 drops the "embed" block (vectors stay off); re-add it, or set a preset\'s semantic back to true, to turn them on');
    }
    return result;
  },
  // v4 -> v5: embed.type renames to embed.provider -- there are only three wire protocols
  // now, so a provider name fits the shape better than a loader "type". "api" auto-migrates to
  // "openai", the wire protocol it always was; any other value is carried over verbatim, since
  // it is what v5 shape validation names the fix for.
  //
  // Also folded in here: a preset's `semantic` migrates to `signals`. false becomes an
  // explicit exhaustive weight map (words, plus links when that feature is on, each at weight
  // 1); true or absent needs no key at all, since default-on already means every signal whose
  // prerequisites hold, each at weight 1. `semantic` leaves the config surface entirely once
  // this step has run.
  4: (cfg) => {
    const prevEmbed = cfg.embed as Record<string, unknown> | undefined;
    const result: Record<string, unknown> = { ...cfg, version: 5 };
    if (prevEmbed) {
      const { type, ...rest } = prevEmbed;
      result.embed = type === undefined ? rest : { ...rest, provider: type === 'api' ? 'openai' : type };
    }

    const linksOn = (cfg.features as Record<string, unknown> | undefined)?.links !== false;
    const presets = cfg.presets as Record<string, Record<string, unknown>> | undefined;
    if (presets) {
      const nextPresets: Record<string, unknown> = {};
      for (const [name, preset] of Object.entries(presets)) {
        const { semantic, ...rest } = preset;
        if (semantic === undefined) {
          nextPresets[name] = preset;
          continue;
        }
        if (typeof semantic !== 'boolean') {
          throw new SenseError('CONFIG_INVALID', `presets.${name}.semantic must be a boolean`);
        }
        nextPresets[name] = semantic === false ? { ...rest, signals: linksOn ? { words: 1, links: 1 } : { words: 1 } } : rest;
      }
      result.presets = nextPresets;
    }
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

// `sense init`'s flags map onto these three `embed` keys one-to-one; an absent field
// keeps the built-in default rather than merging partial input.
export interface InitOverrides {
  model?: string;
  provider?: string;
  url?: string;
}

function starterConfig(overrides?: InitOverrides): Config {
  const embed: Record<string, unknown> = { model: DEFAULT_EMBED_MODEL, provider: 'static' };
  if (overrides?.model !== undefined) embed.model = overrides.model;
  if (overrides?.provider !== undefined) embed.provider = overrides.provider;
  if (overrides?.url !== undefined) embed.url = overrides.url;
  return {
    $schema: 'https://unpkg.com/sensemaking/schema.json',
    version: SUPPORTED_CONFIG_VERSION,
    presets: {
      default: { include: ['**/*.md'], k: 10 },
      large: { include: ['**/*.md'], k: 20 },
    },
    // Written out rather than defaulted in code: this line is what makes `sense download`
    // fetch a model, so it belongs where it can be read and changed.
    embed: embed as Config['embed'],
    queries: {},
  };
}

// Refuses to overwrite an existing config. `overrides` come from `sense init`'s flags; an
// invalid --provider fails validateConfig's own shape check before anything is written.
export function initConfig(dir: string, overrides?: InitOverrides): string {
  const configPath = join(dir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    throw new SenseError('CONFIG_EXISTS', `${CONFIG_FILENAME} already exists in ${dir}`);
  }
  const cfg = starterConfig(overrides);
  validateConfig(cfg, configPath);
  writeFileAtomic(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
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

  // validateConfig only knows the current shape, so scan-shaped files (pre-v3) get a minimal
  // check, migrate, then the full one on the result.
  let cfg: Config;
  let migratedFrom: number | undefined;
  if (version < SUPPORTED_CONFIG_VERSION) {
    if (version < FIRST_PRESET_VERSION) validateLegacyScan(parsed, configPath);
    const result = migrateConfig(parsed as unknown as Config);
    cfg = validateConfig(result.cfg, configPath);
    migratedFrom = result.from;
    writeFileAtomic(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  } else {
    cfg = validateConfig(parsed, configPath);
  }

  const unknownKeys = unknownConfigKeys(cfg as unknown as Record<string, unknown>);
  return { ...cfg, baseDir: dirname(configPath), configPath, migratedFrom, unknownKeys: unknownKeys.length > 0 ? unknownKeys : undefined };
}
