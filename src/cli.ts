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

// An unbound `?` silently binds NULL, so mismatched param counts fail loudly instead.
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

// Thrown errors -> exit 1 with the message verbatim; usage errors exit(2) directly.
export default async function cli(argv: string[], name: string): Promise<void> {
  const { values, positionals } = parseCliArgs(argv, name);

  if (values.help) {
    console.log(usage(name));
    process.exit(0);
  }

  const resolveConfig = () => loadConfig(values.config);

  try {
    const [first, ...rest] = positionals;

    if (first === 'init') {
      const configPath = initConfig(process.cwd());
      console.log(`created ${configPath}`);
      console.log('query away: sense query "SELECT path FROM frontmatter LIMIT 10"');
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
    console.error((err as Error).message);
    process.exit(1);
  }
}
