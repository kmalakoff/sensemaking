import { resolveNote, scopedPaths } from '../commands.ts';
import type { Row } from '../output.ts';
import { printRows } from '../output.ts';
import { findPath } from '../traverse.ts';
import { USAGE } from './index.ts';
import { CONFIG, FORMAT, formatOf, parse, SCOPE, scopeOf, withDb } from './shared.ts';
import type { Command } from './types.ts';

// --max-depth must be a positive integer, mirroring shared.ts's parseK.
function parseMaxDepth(depth: string | undefined, usageError: (message: string) => never): number | undefined {
  if (depth === undefined) return undefined;
  const parsed = Number(depth);
  if (!Number.isInteger(parsed) || parsed <= 0) usageError(`--max-depth expects a positive integer, got "${depth}"`);
  return parsed;
}

const pathCmd: Command = (ctx) => {
  const usage = `usage: ${ctx.name} ${USAGE.path}`;
  const { values, positionals } = parse(ctx.argv, usage, { ...SCOPE, ...FORMAT, ...CONFIG, 'max-depth': { type: 'string' } });
  const [a, b] = positionals;
  if (!a || !b) ctx.usageError(usage);
  const maxDepth = parseMaxDepth(values['max-depth'] as string | undefined, ctx.usageError);
  const format = formatOf(values);
  return withDb(ctx, values.config as string | undefined, (db, cfg) => {
    const paths = (db.prepare('SELECT "path" FROM frontmatter').all() as Array<{ path: string }>).map((r) => r.path);
    const from = resolveNote(paths, a);
    const to = resolveNote(paths, b);
    const allowed = scopedPaths(db, cfg, scopeOf(values));
    const hops = findPath(db, from, to, { maxDepth, allowed });

    if (format === 'json') {
      console.log(JSON.stringify(hops));
      return;
    }
    if (hops === null) {
      console.log(maxDepth ? `no path within ${maxDepth} hops` : 'no path');
      return;
    }
    const rows: Row[] = hops.map((p, step) => ({ step, path: p }));
    printRows(rows, format);
  });
};
export default pathCmd;
