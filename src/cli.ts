import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { COMMANDS, USAGE } from './cli/index.ts';
import type { Ctx } from './cli/types.ts';
import { loadConfig, SUPPORTED_CONFIG_VERSION } from './config.ts';

// Parsing and dispatch only; commands lazy-load from src/cli/, so nothing heavy is imported
// here. Flags parse per command -- this file handles only --version/--help/--list/--config.

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

// Thrown errors -> exit 1 with the message verbatim; usage errors exit 2 directly.
export default async function cli(argv: string[], name: string): Promise<void> {
  const first = argv[0];

  // No command word, or the first token looks like a flag: the only flags this level knows.
  if (!first || first.startsWith('-')) {
    let values: Record<string, string | boolean | undefined>;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          version: { type: 'boolean', default: false, short: 'v' },
          help: { type: 'boolean', default: false, short: 'h' },
          list: { type: 'boolean', default: false },
          config: { type: 'string' },
        },
        allowPositionals: true,
      }));
    } catch (err) {
      console.error((err as Error).message);
      console.error(usage(name));
      process.exit(2);
    }

    try {
      if (values.version) {
        console.log(packageVersion());
        return;
      }
      if (values.help) {
        console.log(usage(name));
        return;
      }
      if (values.list) {
        const queries = resolveConfigFor(name, values.config as string | undefined).queries;
        for (const queryName of Object.keys(queries).sort()) {
          // Every entry names its verb, so --list can label both kinds rather than only
          // marking the exception.
          console.log(`${queryName}  (${'search' in queries[queryName] ? 'search' : 'sql'})`);
        }
        return;
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    console.error(usage(name));
    process.exit(2);
  }

  // Breaking renames get one release of a pointer instead of an "unknown" error: find ->
  // search, and query -> sql (which took its name back from the search sense of "query").
  const RENAMED: Record<string, string> = { find: 'search', query: 'sql' };
  if (RENAMED[first]) {
    console.error(`${name}: ${first} is now ${RENAMED[first]}`);
    console.error(usage(name));
    process.exit(2);
  }

  const ctx: Ctx = {
    name,
    argv: argv.slice(1),
    resolveConfig: (configPath) => resolveConfigFor(name, configPath),
    usageError(message) {
      console.error(message);
      process.exit(2);
    },
  };

  try {
    const load = COMMANDS[first];
    if (load) await (await load()).default(ctx);
    else await (await import('./cli/named.ts')).default(ctx, first);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
