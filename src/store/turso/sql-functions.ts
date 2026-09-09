import { SenseError } from '../../errors.ts';

// Turso can't register UDFs: has()/basename() are rewritten into portable SQL below; segment()
// (Intl.Segmenter grapheme clustering, types.ts's 'segment' capability) has none, so it's rejected like an unsupported FTS5 operator.

// Non-global: recursion (readArgs' contents rewritten via rewriteFunctions) reenters this module's
// regexes before the outer scan resumes, and a global regex's lastIndex does not nest across that.
const CALL_ANYWHERE = /\b(has|basename|segment)\s*\(/i;
const CALL_AT_START = /^(has|basename|segment)\s*\(/i;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

// The index just past the quoted literal or SQL comment starting at i, or null if i starts
// neither. Shared by the scan and readArgs so both leave quoted/comment text opaque to a call match.
function skipOpaque(sql: string, i: number): number | null {
  const ch = sql[i];
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === ch) {
        if (sql[j + 1] === ch) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return j; // unterminated literal: consume to end rather than loop forever
  }
  if (ch === '-' && sql[i + 1] === '-') {
    const nl = sql.indexOf('\n', i);
    return nl === -1 ? sql.length : nl + 1;
  }
  if (ch === '/' && sql[i + 1] === '*') {
    const close = sql.indexOf('*/', i + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return null;
}

// `?N`/named placeholders bind by number/name, so repeating one is safe; an anonymous `?` takes
// the next slot per occurrence, so it's numbered here first -- sqlHas/sqlBasename duplicate their arguments.
function numberPlaceholders(sql: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  while (i < sql.length) {
    const skip = skipOpaque(sql, i);
    if (skip !== null) {
      out += sql.slice(i, skip);
      i = skip;
      continue;
    }
    if (sql[i] === '?' && !/[0-9]/.test(sql[i + 1] ?? '')) {
      n++;
      out += `?${n}`;
      i++;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

// The un-rewritten argument texts of the call whose '(' sits at parenStart, and the index just
// past its matching ')'. Paren depth is tracked so a nested call's commas/parens aren't mistaken for ours.
function readArgs(sql: string, parenStart: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 1;
  let cur = '';
  let i = parenStart + 1;
  while (i < sql.length) {
    const skip = skipOpaque(sql, i);
    if (skip !== null) {
      cur += sql.slice(i, skip);
      i = skip;
      continue;
    }
    const ch = sql[i];
    if (ch === '(') {
      depth++;
      cur += ch;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) break;
      cur += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (depth !== 0) throw new Error(`turso: unterminated argument list starting at "${sql.slice(parenStart, parenStart + 30)}..."`);
  if (cur.trim() !== '') args.push(cur.trim());
  return { args, end: i };
}

// field.startsWith('[') && JSON.parse(field) is an array, matched by membership; every other
// field, stringified, matched by substring (sql-functions.ts's hasImpl, mirrored branch for branch).
function sqlHas(fieldExpr: string, valueExpr: string): string {
  const isArray = `substr(${fieldExpr},1,1) = '[' AND json_valid(${fieldExpr})`;
  // json_each's argument is re-guarded by its own CASE (falling back to '[]'): turso evaluates a
  // CASE branch's table function even when untaken, and a non-array argument there raises rather than yielding 0 rows (spike-verified).
  return `(CASE
    WHEN ${fieldExpr} IS NULL THEN 0
    WHEN ${isArray} THEN
      (SELECT COUNT(*) FROM json_each(CASE WHEN ${isArray} THEN ${fieldExpr} ELSE '[]' END) je WHERE CAST(je.value AS TEXT) = CAST(${valueExpr} AS TEXT)) > 0
    ELSE instr(CAST(${fieldExpr} AS TEXT), CAST(${valueExpr} AS TEXT)) > 0
  END)`;
}

// posix.basename(String(path)), suffix stripped Unix-style (sql-functions.ts's basenameImpl). No
// last-'/' primitive exists, so reverse() finds the first '/' from the end, then reverse() restores order.
function sqlBasename(pathExpr: string, suffixExpr: string): string {
  const trimmed = `rtrim(CAST(${pathExpr} AS TEXT), '/')`;
  const name = `CASE
      WHEN ${trimmed} = '' THEN ''
      WHEN instr(${trimmed}, '/') = 0 THEN ${trimmed}
      ELSE reverse(substr(reverse(${trimmed}), 1, instr(reverse(${trimmed}), '/') - 1))
    END`;
  return `(CASE WHEN ${pathExpr} IS NULL THEN NULL ELSE
    (CASE WHEN ${suffixExpr} IS NOT NULL AND CAST(${suffixExpr} AS TEXT) != '' AND CAST(${suffixExpr} AS TEXT) != (${name})
          AND substr((${name}), -length(CAST(${suffixExpr} AS TEXT))) = CAST(${suffixExpr} AS TEXT)
     THEN substr((${name}), 1, length((${name})) - length(CAST(${suffixExpr} AS TEXT)))
     ELSE (${name}) END)
  END)`;
}

// Rewrites every has()/basename() call into the portable SQL above, recursing into each call's own
// arguments first so a nested `instr(basename(f.path), 'x')` resolves inside out; segment() instead raises STORE_CAPABILITY_MISSING, named, like an unsupported FTS5 operator.
export function rewriteFunctions(sql: string): string {
  if (!CALL_ANYWHERE.test(sql)) return sql;
  // Numbered once, over the whole statement, before any argument is duplicated below -- rewrite()
  // recurses over already-numbered substrings, never renumbering them a second time.
  return rewrite(numberPlaceholders(sql));
}

function rewrite(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const skip = skipOpaque(sql, i);
    if (skip !== null) {
      out += sql.slice(i, skip);
      i = skip;
      continue;
    }
    const m = !isWordChar(sql[i - 1]) ? CALL_AT_START.exec(sql.slice(i)) : null;
    if (m) {
      const name = m[1].toLowerCase();
      const parenStart = i + m[0].length - 1;
      if (name === 'segment') {
        throw new SenseError('STORE_CAPABILITY_MISSING', `store "turso" does not implement segment() as a SQL function in this build (its client cannot register UDFs); rephrase the query without it, or set "store" to "sqlite" in this tree's config to run it as written`);
      }
      const { args, end } = readArgs(sql, parenStart);
      const rewrittenArgs = args.map(rewrite);
      if (name === 'has') {
        if (rewrittenArgs.length !== 2) throw new Error(`turso: has() takes exactly 2 arguments (field, value), got ${rewrittenArgs.length}`);
        out += sqlHas(rewrittenArgs[0], rewrittenArgs[1]);
      } else {
        if (rewrittenArgs.length < 1 || rewrittenArgs.length > 2) throw new Error(`turso: basename() takes 1 or 2 arguments (path, suffix?), got ${rewrittenArgs.length}`);
        out += sqlBasename(rewrittenArgs[0], rewrittenArgs[1] ?? 'NULL');
      }
      i = end;
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}
