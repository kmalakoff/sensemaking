import { search } from '../commands.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// A saved query that returns zero rows looks identical to a true empty result, so a broken
// one can sit unnoticed -- one field report had `WHERE flag = 'true'` against a numeric
// column reading as "nothing tagged yet" for hours. Preparing each query catches syntax and
// unknown-column errors without executing it; queries that take no parameters are also run
// for a row count. Parameterised queries are validated but not counted: inventing arguments
// would report a count for a query nobody ran. Saved searches run lexically with k=1 -- that
// validates the `where` fragment, the FTS5 terms, and the `preset` name (resolveSearch throws
// on an unknown one, the same breakage class prepare() catches for SQL strings) -- but never
// semantically (a semantic pass costs model time and, on api trees, network). Whether a
// result being empty is good or bad is the reader's judgment -- there is no assertion path.
const check: Command = async (ctx) => {
  const { values } = parse(ctx.argv, `usage: ${ctx.name} ${USAGE.check}`, { ...FORMAT, ...CONFIG });
  const format = formatOf(values);
  const cfg = ctx.resolveConfig(values.config as string | undefined);
  const { db, warnings } = open(cfg);
  printWarnings(warnings);

  const rows: Row[] = [];
  let failed = 0;
  for (const [name, entry] of Object.entries(cfg.queries ?? {})) {
    if (typeof entry === 'object' && entry !== null && 'search' in entry) {
      try {
        const count = (await search(db, cfg, entry.search, { k: 1, where: entry.where, preset: entry.preset, include: entry.include, semantic: false })).length;
        rows.push({ query: name, params: '—', rows: '—', status: count === 0 ? 'ok, but matches 0 notes (lexical probe)' : 'ok (probe run with k=1)' });
      } catch (err) {
        failed++;
        rows.push({ query: name, params: '—', rows: '—', status: `FAILED: ${(err as Error).message}` });
      }
      continue;
    }
    const sql = typeof entry === 'string' ? entry : entry.sql;
    const params = (sql.match(/\?/g) ?? []).length;
    try {
      const statement = db.prepare(sql);
      if (params > 0) {
        rows.push({ query: name, params, rows: '—', status: 'ok (not run: needs parameters)' });
        continue;
      }
      const count = (statement.all() as unknown[]).length;
      rows.push({ query: name, params, rows: count, status: count === 0 ? 'ok, but returns 0 rows' : 'ok' });
    } catch (err) {
      failed++;
      rows.push({ query: name, params, rows: '—', status: `FAILED: ${(err as Error).message}` });
    }
  }

  db.close();
  if (rows.length === 0) {
    console.log('no saved queries in config');
    return;
  }
  printRows(rows, format);
  if (failed > 0) process.exit(1);
};
export default check;
