import { parseArgs } from 'node:util';
import type { ResolvedConfig } from './config.ts';
import { initConfig, loadConfig } from './config.ts';
import { docCount, getMeta, open, rebuild } from './db.ts';
import type { Row } from './output.ts';
import { printRows } from './output.ts';
import type { WatchEvent } from './watch.ts';
import { runWatch } from './watch.ts';

function usage(name: string): string {
  return `usage: ${name} <name> [params...] [--format table|json] [--config path]\n` + `       ${name} query "<sql>" [params...]\n` + `       ${name} --list\n` + `       ${name} init\n` + `       ${name} watch [--force]\n` + `       ${name} status\n` + `       ${name} rebuild`;
}

function parseCliArgs(argv: string[], name: string) {
  try {
    return parseArgs({
      args: argv,
      options: {
        format: { type: 'string', default: 'table' },
        config: { type: 'string' },
        list: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false, short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage(name));
    process.exit(2);
  }
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.warn(w);
}

// Shared tail of both the named-query and ad-hoc `query` paths. An unbound
// `?` silently binds NULL and returns misleading empty results — fail
// loudly instead. (Naive count; queries putting '?' in string literals
// would miscount, which none of ours do.)
function runSql(cfg: ResolvedConfig, sql: string, params: string[], format: 'table' | 'json', label: string): void {
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  if (params.length !== placeholderCount) {
    console.error(`${label} expects ${placeholderCount} parameter(s), got ${params.length}`);
    process.exit(2);
  }
  const { db, warnings } = open(cfg);
  printWarnings(warnings);
  const rows = db.prepare(sql).all(...params) as Row[];
  printRows(rows, format);
  db.close();
}

function logWatchEvent(event: WatchEvent): void {
  if (event.type === 'started') {
    console.log(`sense watch: watching ${event.baseDir}`);
    console.log(`sense watch: db ${event.dbPath}`);
    return;
  }
  if (event.type === 'reconciled') {
    printWarnings(event.warnings);
    if (event.parsed > 0) {
      console.log(`sense watch: reconciled, ${event.parsed} file(s) reparsed (${event.total} total)`);
    }
    return;
  }
  console.error(`sense watch: reconcile error: ${event.message}`);
}

// Everything below that can throw (bad JSON, a config `version` newer than
// this build supports, another watcher's fresh heartbeat, a SQLite error)
// is caught by the top-level handler below and reported as exit 1 with the
// error's message verbatim. Usage errors (missing/unknown query name, wrong
// parameter count) exit(2) directly instead of throwing.
export default async function cli(argv: string[], name: string): Promise<void> {
  const { values, positionals } = parseCliArgs(argv, name);

  if (values.help) {
    console.log(usage(name));
    process.exit(0);
  }

  // cli.ts's only config knowledge is the --config flag; discovery, parsing,
  // and version-gating all live in config.ts.
  const resolveConfig = () => loadConfig(values.config);

  try {
    const [first, ...rest] = positionals;

    if (first === 'init') {
      const configPath = initConfig(process.cwd());
      console.log(`created ${configPath}`);
      console.log('edit the queries to fit your tree, then: sense --list');
      process.exit(0);
    }

    if (first === 'watch') {
      const cfg = resolveConfig();
      await runWatch(cfg, { force: values.force, onEvent: logWatchEvent });
      process.exit(0);
    }

    if (first === 'status') {
      const cfg = resolveConfig();
      const { db, dbPath, warnings } = open(cfg);
      printWarnings(warnings);
      console.log(`db: ${dbPath}`);
      console.log(`docs: ${docCount(db)}`);
      const heartbeat = getMeta(db, 'watch_heartbeat');
      if (heartbeat) {
        const ageSec = Math.round((Date.now() - Date.parse(heartbeat)) / 1000);
        console.log(`watcher: last heartbeat ${ageSec}s ago`);
      } else {
        console.log('watcher: no watcher');
      }
      db.close();
      process.exit(0);
    }

    if (first === 'rebuild') {
      const cfg = resolveConfig();
      const result = rebuild(cfg);
      printWarnings(result.warnings);
      console.log(`rebuilt: ${docCount(result.db)} docs`);
      result.db.close();
      process.exit(0);
    }

    if (values.list) {
      const cfg = resolveConfig();
      for (const queryName of Object.keys(cfg.queries).sort()) console.log(queryName);
      process.exit(0);
    }

    const format = values.format === 'json' ? 'json' : 'table';

    // Ad-hoc SQL without touching the config -- for one-off questions;
    // save a query into sense.config.json only when it'll be reused.
    if (first === 'query') {
      const [sql, ...params] = rest;
      if (!sql) {
        console.error(`usage: ${name} query "<sql>" [params...]`);
        process.exit(2);
      }
      runSql(resolveConfig(), sql, params, format, 'ad-hoc query');
      return;
    }

    const [name_, ...params] = [first, ...rest];

    if (!name_) {
      console.error(usage(name));
      process.exit(2);
    }

    const cfg = resolveConfig();

    const sql = cfg.queries[name_];
    if (!sql) {
      console.error(`unknown query: "${name_}"`);
      console.error(`valid queries: ${Object.keys(cfg.queries).sort().join(', ')}`);
      process.exit(2);
    }

    runSql(cfg, sql, params, format, `query "${name_}"`);
  } catch (err) {
    // SQLite's own error message, a bad config, an unsupported config
    // version, or an already-active watcher — printed verbatim.
    console.error((err as Error).message);
    process.exit(1);
  }
}
