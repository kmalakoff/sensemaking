import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SenseError } from './errors.ts';

export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// Highest sense.config.json `version` this build understands. Older versions auto-migrate on load.
export const SUPPORTED_CONFIG_VERSION = 2;

// Each feature owns its tables, parse-time extraction, and reconcile step; verbs degrade when one is off.
export const FEATURE_NAMES = ['links', 'sections', 'rank'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

export interface Config {
  // Editor-only pointer to schema.json; never read by sense.
  $schema?: string;
  version?: number;
  scan: { include: string[] };
  features?: Partial<Record<FeatureName, boolean>>;
  queries: Record<string, string>;
}

export interface ResolvedConfig extends Config {
  baseDir: string;
  configPath: string | null;
  // Set when loadConfig auto-migrated the file on disk; cli reports it.
  migratedFrom?: number;
}

// Absent block or key means enabled -- features are opt-out. `rank` additionally requires `links`.
export function featureEnabled(cfg: Config, name: FeatureName): boolean {
  const enabled = cfg.features?.[name] !== false;
  if (name === 'rank') return enabled && featureEnabled(cfg, 'links');
  return enabled;
}

export function enabledFeatures(cfg: Config): FeatureName[] {
  return FEATURE_NAMES.filter((name) => featureEnabled(cfg, name));
}

// Pure per-version steps; loadConfig chains them from the file's version up to SUPPORTED_CONFIG_VERSION.
const MIGRATIONS: Record<number, (cfg: Config) => Config> = {
  // v1 -> v2: features block introduced, everything enabled (matches the old implicit behavior of `links` etc. not existing).
  1: (cfg) => ({ ...cfg, version: 2, features: Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as Config['features'] }),
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
    features: Object.fromEntries(FEATURE_NAMES.map((name) => [name, true])) as Config['features'],
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
  let cfg = JSON.parse(raw) as Config;

  const version = cfg.version ?? 1;
  if (version > SUPPORTED_CONFIG_VERSION) {
    throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `config version ${version} requires a newer sense`);
  }

  let migratedFrom: number | undefined;
  if (version < SUPPORTED_CONFIG_VERSION) {
    const result = migrateConfig(cfg);
    cfg = result.cfg;
    migratedFrom = result.from;
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  }

  return { ...cfg, baseDir: dirname(configPath), configPath, migratedFrom };
}
