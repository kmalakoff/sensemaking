import { createRequire } from 'node:module';
import exit from 'exit-compat';
import getopts from 'getopts-compat';
import { ExitError, usageError } from './cli/exit.ts';
import { COMMANDS, USAGE } from './cli/index.ts';
import type { Ctx } from './cli/types.ts';
import { loadConfig, SUPPORTED_CONFIG_VERSION } from './config.ts';

// Parsing and dispatch only. Commands live in src/cli/, one file each, lazy-loaded --
// nothing tree- or dependency-heavy may be imported at the top of this file. Flags parse
// per command (each command's own parse() call); this file only handles the bare top-level
// flags (--version/--help/--list/--config) and dispatch, and owns the single exit.

// Works from dist/cjs and dist/esm alike: walk up past the dist type-marker package.json.
function packageVersion(): string {
  const load = createRequire(import.meta.url);
  for (const rel of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const pkg = load(rel) as { name?: string; version?: string };
      if (pkg.name === 'sensemaking' && pkg.version) return pkg.version;
    } catch {}
  }
  return 'unknown';
}

function usage(name: string): string {
  const lines = Object.values(USAGE).map((u) => `       ${name} ${u}`);
  return [`usage: ${name} <name> [params...] [--format table|json] [--config path]`, ...lines, `       ${name} --list`, `       ${name} --version`].join('\n');
}

function resolveConfigFor(name: string, configPath: string | undefined) {
  const cfg = loadConfig(configPath);
  if (cfg.migratedFrom !== undefined) {
    console.warn(`${name}: migrated ${cfg.configPath} from config version ${cfg.migratedFrom} to ${SUPPORTED_CONFIG_VERSION}`);
  }
  if (cfg.unknownKeys !== undefined) {
    console.warn(`${name}: ${cfg.configPath} sets ${cfg.unknownKeys.join(', ')}, which this build does not read (no effect); see schema.json for the keys it does`);
  }
  return cfg;
}

// The top level knows four flags and nothing else; everything past the command word is the
// command's to parse. Reached only when there is no command word, or the first token is a flag.
function topLevel(argv: string[], name: string): void {
  let unknown: string | undefined;
  const opts = getopts(argv, {
    string: ['config'],
    boolean: ['version', 'help', 'list'],
    alias: { version: 'v', help: 'h' },
    default: { version: false, help: false, list: false },
    unknown: (flag: string): boolean => {
      if (unknown === undefined) unknown = flag;
      return false;
    },
  });
  if (unknown !== undefined) usageError(`unknown option: ${unknown}`, usage(name));

  if (opts.version) {
    console.log(packageVersion());
    return;
  }
  if (opts.help) {
    console.log(usage(name));
    return;
  }
  if (opts.list) {
    const queries = resolveConfigFor(name, opts.config === '' ? undefined : (opts.config as string)).queries;
    for (const queryName of Object.keys(queries).sort()) {
      const entry = queries[queryName];
      const isSavedSearch = typeof entry === 'object' && entry !== null && 'search' in entry;
      console.log(isSavedSearch ? `${queryName}  (search)` : queryName);
    }
    return;
  }
  console.error(usage(name));
  throw new ExitError(2);
}

// ExitError carries a chosen code; anything else is an error -> exit 1 with its message.
export default async function cli(argv: string[], name: string): Promise<void> {
  try {
    const first = argv[0];
    if (!first || first.startsWith('-')) {
      topLevel(argv, name);
      return;
    }

    // find -> search (breaking rename): one release of a pointer instead of "unknown query".
    if (first === 'find') usageError(`${name}: find is now search`, usage(name));

    const ctx: Ctx = {
      name,
      argv: argv.slice(1),
      resolveConfig: (configPath) => resolveConfigFor(name, configPath),
      usageError: (message) => usageError(message),
    };

    const load = COMMANDS[first];
    if (load) await (await load()).default(ctx);
    else await (await import('./cli/named.ts')).default(ctx, first);
  } catch (err) {
    if (err instanceof ExitError) {
      exit(err.code);
      return;
    }
    console.error((err as Error).message);
    exit(1);
  }
}
