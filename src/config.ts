import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SenseError } from './errors.ts';

export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// Highest sense.config.json `version` this build understands. Older versions auto-migrate on load.
export const SUPPORTED_CONFIG_VERSION = 2;

// Each feature owns its tables, parse-time extraction, and reconcile step; verbs degrade when one is off.
// links/sections/rank are opt-out (absent = on); embed is opt-in (absent = off) -- most trees don't need vectors.
const FEATURE_NAMES = ['links', 'sections', 'rank', 'embed'] as const;
const OPT_OUT_NAMES = ['links', 'sections', 'rank'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

// `true` = all defaults (static type, default model). A local `model` path skips the network.
export interface EmbedConfig {
  model?: string;
  type?: 'static' | 'api';
  url?: string; // api type: OpenAI-compatible base URL, e.g. http://localhost:11434/v1
  key?: string; // api type: name of the env var holding the bearer token, if any
}

export const DEFAULT_EMBED_MODEL = 'minishlab/potion-retrieval-32M';

export interface Config {
  // Editor-only pointer to schema.json; never read by sense.
  $schema?: string;
  version?: number;
  scan: { include: string[] };
  features?: { links?: boolean; sections?: boolean; rank?: boolean; embed?: boolean | EmbedConfig };
  queries: Record<string, string>;
}

export interface ResolvedConfig extends Config {
  baseDir: string;
  configPath: string | null;
  // Set when loadConfig auto-migrated the file on disk; cli reports it.
  migratedFrom?: number;
}

// Opt-out features: absent block or key means enabled. `rank` additionally requires `links`.
// `embed` is the opposite: enabled only when the config says so.
export function featureEnabled(cfg: Config, name: FeatureName): boolean {
  if (name === 'embed') return Boolean(cfg.features?.embed);
  const enabled = cfg.features?.[name] !== false;
  if (name === 'rank') return enabled && featureEnabled(cfg, 'links');
  return enabled;
}

export function enabledFeatures(cfg: Config): FeatureName[] {
  return FEATURE_NAMES.filter((name) => featureEnabled(cfg, name));
}

// Every feature with its current state; verbs surface this so "off" and "empty" stay
// distinguishable in output.
export function featureStates(cfg: Config): { on: FeatureName[]; off: FeatureName[] } {
  return {
    on: FEATURE_NAMES.filter((name) => featureEnabled(cfg, name)),
    off: FEATURE_NAMES.filter((name) => !featureEnabled(cfg, name)),
  };
}

// Resolved embed settings, or null when the feature is off.
export function embedConfig(cfg: Config): { model: string; type: 'static' | 'api'; url?: string; key?: string } | null {
  const e = cfg.features?.embed;
  if (!e) return null;
  const o = e === true ? {} : e;
  return { model: o.model ?? DEFAULT_EMBED_MODEL, type: o.type ?? 'static', url: o.url, key: o.key };
}

// Cache-key string: embed carries its type + model so a model change rebuilds like a toggle.
export function featureSignature(cfg: Config): string {
  return enabledFeatures(cfg)
    .map((name) => {
      if (name !== 'embed') return name;
      const e = embedConfig(cfg);
      return `embed:${e?.type}:${e?.model}`;
    })
    .join(',');
}

// Pure per-version steps; loadConfig chains them from the file's version up to SUPPORTED_CONFIG_VERSION.
const MIGRATIONS: Record<number, (cfg: Config) => Config> = {
  // v1 -> v2: features block introduced, opt-out features enabled (matches the old implicit
  // behavior of `links` etc. not existing). embed stays absent -- opt-in.
  1: (cfg) => ({ ...cfg, version: 2, features: Object.fromEntries(OPT_OUT_NAMES.map((name) => [name, true])) as Config['features'] }),
};

export function migrateConfig(cfg: Config): { cfg: Config; from: number } {
  const from = cfg.version ?? 1;
  let current = cfg;
  for (let v = from; v < SUPPORTED_CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `no migration from config version ${v}`);
    current = step(current);
  }
  return { cfg: current, from };
}

function starterConfig(): Config {
  return {
    $schema: 'https://unpkg.com/sensemaking/schema.json',
    version: SUPPORTED_CONFIG_VERSION,
    scan: { include: ['**/*.md'] },
    features: Object.fromEntries(OPT_OUT_NAMES.map((name) => [name, true])) as Config['features'],
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
// on disk (absent = none); `scan.include` has no usable default.
function validateConfig(parsed: unknown, configPath: string): Config {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: config must be a JSON object`);
  }
  const cfg = parsed as Record<string, unknown>;
  const scan = cfg.scan as { include?: unknown } | undefined;
  if (!scan || !Array.isArray(scan.include) || scan.include.length === 0 || !scan.include.every((g) => typeof g === 'string')) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: scan.include must be a non-empty array of glob strings`);
  }
  if (cfg.queries === undefined) cfg.queries = {};
  if (typeof cfg.queries !== 'object' || cfg.queries === null || Array.isArray(cfg.queries) || !Object.values(cfg.queries).every((q) => typeof q === 'string')) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: queries must be an object of name -> SQL string`);
  }
  if (cfg.features !== undefined && (typeof cfg.features !== 'object' || cfg.features === null || Array.isArray(cfg.features))) {
    throw new SenseError('CONFIG_INVALID', `${configPath}: features must be an object of name -> boolean`);
  }
  for (const [name, value] of Object.entries(cfg.features ?? {})) {
    if (typeof value === 'boolean') continue;
    // embed alone takes an object form: { model?, type?: static|api, url?, key? }.
    const embed = value as Record<string, unknown>;
    const shapeOk = name === 'embed' && typeof value === 'object' && value !== null && !Array.isArray(value) && ['model', 'url', 'key'].every((f) => embed[f] === undefined || typeof embed[f] === 'string') && (embed.type === undefined || embed.type === 'static' || embed.type === 'api');
    if (!shapeOk) {
      throw new SenseError('CONFIG_INVALID', `${configPath}: features.${name} must be a boolean${name === 'embed' ? ' or { model?, type?: "static"|"api", url?, key? }' : ''}`);
    }
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

  // Version gate before shape validation: a config written by a newer sense should fail
  // with "requires a newer sense", not with shape errors its own version may not have.
  const version = typeof parsed === 'object' && parsed !== null && typeof (parsed as { version?: unknown }).version === 'number' ? (parsed as { version: number }).version : 1;
  if (version > SUPPORTED_CONFIG_VERSION) {
    throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `config version ${version} requires a newer sense`);
  }

  let cfg = validateConfig(parsed, configPath);

  let migratedFrom: number | undefined;
  if (version < SUPPORTED_CONFIG_VERSION) {
    const result = migrateConfig(cfg);
    cfg = result.cfg;
    migratedFrom = result.from;
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }

  return { ...cfg, baseDir: dirname(configPath), configPath, migratedFrom };
}
