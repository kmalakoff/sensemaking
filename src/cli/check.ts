import { find } from '../commands.ts';
import { featureEnabled } from '../config.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// A saved query that returns zero rows looks identical to a true empty result, so a broken
// one can sit unnoticed -- one field report had `WHERE flag = 'true'` against a numeric
// column reading as "nothing tagged yet" for hours. Preparing each query catches syntax and
// unknown-column errors without executing it; queries that take no parameters are also run
// for a row count. Parameterised queries are validated but not counted: inventing arguments
// would report a count for a query nobody ran. Saved finds run lexically with k=1 -- that
// validates the `where` fragment and the FTS5 terms against the real schema, the same
// breakage class prepare() catches for SQL strings -- but never semantically (a --semantic
// pass costs model time and, on api trees, network); `semantic: true` is only checked for
// a features.embed to run against.
const check: Command = async (ctx) => {
  const cfg = ctx.resolveConfig();
  const { db, warnings } = open(cfg);
  printWarnings(warnings);

  const rows: Row[] = [];
  let failed = 0;
  for (const [name, entry] of Object.entries(cfg.queries ?? {})) {
    if (typeof entry !== 'string') {
      if (entry.semantic && !featureEnabled(cfg, 'embed')) {
        failed++;
        rows.push({ query: name, params: '—', rows: '—', status: 'FAILED: semantic requested but features.embed is off' });
        continue;
      }
      try {
        const count = (await find(db, cfg, entry.find, { k: 1, where: entry.where })).length;
        rows.push({ query: name, params: '—', rows: '—', status: count === 0 ? 'ok, but matches 0 notes (lexical probe)' : entry.semantic ? 'ok (lexical probe; semantic not run)' : 'ok (probe run with k=1)' });
      } catch (err) {
        failed++;
        rows.push({ query: name, params: '—', rows: '—', status: `FAILED: ${(err as Error).message}` });
      }
      continue;
    }
    const sql = entry;
    const params = (sql.match(/\?/g) ?? []).length;
    const expectEmpty = cfg.checks?.[name] === 'empty';
    try {
      const statement = db.prepare(sql);
      if (params > 0) {
        rows.push({ query: name, params, rows: '—', status: 'ok (not run: needs parameters)' });
        continue;
      }
      const count = (statement.all() as unknown[]).length;
      if (expectEmpty) {
        // An invariant query: rows are violations, so 0 is the pass, anything else fails.
        if (count > 0) failed++;
        rows.push({ query: name, params, rows: count, status: count === 0 ? 'ok (empty, as asserted)' : `FAILED: expected empty, returned ${count} row(s)` });
      } else {
        rows.push({ query: name, params, rows: count, status: count === 0 ? 'ok, but returns 0 rows' : 'ok' });
      }
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
  printRows(rows, ctx.format);
  if (failed > 0) process.exit(1);
};
export default check;
