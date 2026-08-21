import { search } from '../commands.ts';
import { open } from '../db.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, printWarnings } from './shared.ts';
import type { Command } from './types.ts';

// A broken query and an empty one look identical, so prepare each to catch syntax and column
// errors. Parameterised ones are not run (inventing arguments would report a bogus count);
// searches probe at k=1 without vectors. Empty results are the reader's judgment, not a fail.
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
        const count = (await search(db, cfg, entry.search, { k: 1, where: entry.where, preset: entry.preset, include: entry.include, exclude: entry.exclude, probe: true })).length;
        rows.push({ query: name, params: '—', rows: '—', status: count === 0 ? 'ok, but matches 0 notes (words and links only)' : 'ok (probe run with k=1)' });
      } catch (err) {
        failed++;
        rows.push({ query: name, params: '—', rows: '—', status: `FAILED: ${(err as Error).message}` });
      }
      continue;
    }
    const sql = entry.sql;
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
