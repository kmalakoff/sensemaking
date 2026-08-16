import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { COMMANDS } from './cli/index.ts';
import type { Ctx } from './cli/types.ts';
import { loadConfig, SUPPORTED_CONFIG_VERSION } from './config.ts';

// Parsing and dispatch only. Commands live in src/cli/, one file each, lazy-loaded --
// nothing tree- or dependency-heavy may be imported at the top of this file.

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
  return (
    `usage: ${name} <name> [params...] [--format table|json] [--config path]\n` +
    `       ${name} query "<sql>" [params...]\n` +
    `       ${name} search "<terms>" [--preset name] [--include glob ...] [--where "<sql>"] [--k n] [--lexical]\n` +
    `       ${name} map\n` +
    `       ${name} peek <path>\n` +
    `       ${name} --list\n` +
    `       ${name} init\n` +
    `       ${name} watch [--force]\n` +
    `       ${name} status\n` +
    `       ${name} check\n` +
    `       ${name} rebuild\n` +
    `       ${name} --version`
  );
}

// Thrown errors -> exit 1 with the message verbatim; usage errors exit 2 directly.
export default async function cli(argv: string[], name: string): Promise<void> {
  let values: Record<string, string | boolean | string[] | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        format: { type: 'string', default: 'table' },
        config: { type: 'string' },
        where: { type: 'string' },
        k: { type: 'string' },
        preset: { type: 'string' },
        include: { type: 'string', multiple: true },
        lexical: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false, short: 'v' },
        help: { type: 'boolean', default: false, short: 'h' },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage(name));
    process.exit(2);
  }

  if (values.version) {
    console.log(`v${packageVersion()}`);
    return;
  }
  if (values.help) {
    console.log(usage(name));
    return;
  }

  const ctx: Ctx = {
    name,
    rest: positionals.slice(1),
    format: values.format === 'json' ? 'json' : 'table',
    values: values as Ctx['values'],
    resolveConfig() {
      const cfg = loadConfig(values.config as string | undefined);
      if (cfg.migratedFrom !== undefined) {
        console.warn(`${name}: migrated ${cfg.configPath} from config version ${cfg.migratedFrom} to ${SUPPORTED_CONFIG_VERSION}`);
      }
      if (cfg.unknownKeys !== undefined) {
        console.warn(`${name}: ${cfg.configPath} sets ${cfg.unknownKeys.join(', ')}, which this build does not read (no effect); see schema.json for the keys it does`);
      }
      return cfg;
    },
    usageError(message) {
      console.error(message);
      process.exit(2);
    },
  };

  try {
    if (values.list) {
      const queries = ctx.resolveConfig().queries;
      for (const queryName of Object.keys(queries).sort()) {
        const entry = queries[queryName];
        const isSavedSearch = typeof entry === 'object' && entry !== null && 'search' in entry;
        console.log(isSavedSearch ? `${queryName}  (search)` : queryName);
      }
      return;
    }

    const [first, ...params] = positionals;
    if (!first) {
      console.error(usage(name));
      process.exit(2);
    }

    // find -> search (breaking rename): one release of a pointer instead of "unknown query".
    if (first === 'find') {
      console.error(`${name}: find is now search`);
      console.error(usage(name));
      process.exit(2);
    }

    const load = COMMANDS[first];
    if (load) await (await load()).default(ctx);
    else await (await import('./cli/named.ts')).default(ctx, first, params);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
