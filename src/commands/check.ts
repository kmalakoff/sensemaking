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
// would report a count for a query nobody ran.
const check: Command = (ctx) => {
  const cfg = ctx.resolveConfig();
  const { db, warnings } = open(cfg);
  printWarnings(warnings);

  const rows: Row[] = [];
  let failed = 0;
  for (const [name, sql] of Object.entries(cfg.queries ?? {})) {
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
  printRows(rows, ctx.format);
  if (failed > 0) process.exit(1);
};
export default check;
