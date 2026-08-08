import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SenseError } from './errors.ts';

// All config concerns live here: the file name, discovery, parsing, and
// version gating. db.ts consumes only the result -- it does no discovery
// and no version logic of its own.

export const CONFIG_FILENAME = 'sense.config.json';
export const STATE_DIR = '.sense';

// The highest `sense.config.json` `version` this build understands. Bumped
// only when the config *format* changes in a breaking way -- unrelated to
// the package's own semver.
export const SUPPORTED_CONFIG_VERSION = 1;

// sense.config.json's on-disk shape.
export interface Config {
  // Editor-only pointer to schema.json; never read by sense.
  $schema?: string;
  // Config format version. Omitted = 1.
  version?: number;
  scan: { include: string[] };
  queries: Record<string, string>;
}

// A Config resolved to where it lives on disk (or, for tests, a baseDir
// supplied directly with no backing file). `scan.include` globs and the
// `.sense/` state dir both resolve relative to `baseDir`, never process cwd.
export interface ResolvedConfig extends Config {
  baseDir: string;
  configPath: string | null;
}

// `sense init`: write a starter config into `dir` — the example doubles as
// the documentation of the format. Refuses to overwrite an existing one.
export function initConfig(dir: string): string {
  const configPath = join(dir, CONFIG_FILENAME);
  if (existsSync(configPath)) {
    throw new SenseError('CONFIG_EXISTS', `${CONFIG_FILENAME} already exists in ${dir}`);
  }
  const starter: Config = {
    $schema: 'https://unpkg.com/sensemaking/schema.json',
    version: 1,
    scan: { include: ['**/*.md'] },
    queries: {
      all: 'SELECT path, title FROM docs ORDER BY path',
      'by-tag': 'SELECT path, title FROM docs WHERE has(tags, ?) ORDER BY path',
    },
  };
  writeFileSync(configPath, `${JSON.stringify(starter, null, 2)}\n`);
  return configPath;
}

// Find sense.config.json by walking up from startDir, git-style.
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

// Resolve + load sense.config.json: `explicitPath` bypasses walk-up
// discovery (as `--config` does on the CLI); otherwise discovery starts at
// process cwd. Throws on a missing config, invalid JSON, or a `version`
// newer than this build supports -- callers surface the message and exit 1.
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
  const cfg = JSON.parse(raw) as Config;

  // Missing `version` is treated as 1. A version newer than this build
  // supports is a hard error -- misinterpreting a future config format
  // silently would be worse than refusing to run.
  const version = cfg.version ?? 1;
  if (version > SUPPORTED_CONFIG_VERSION) {
    throw new SenseError('CONFIG_VERSION_UNSUPPORTED', `config version ${version} requires a newer sense`);
  }

  return { ...cfg, baseDir: dirname(configPath), configPath };
}
