import { isCollection, parseDocument, visit } from 'yaml';

// Frontmatter keys that would collide with table columns. Exported so reconcile.ts's upsert can tell
// a feature-owned column (`_rank`) from a parsed one and leave it alone on reparse.
export const RESERVED_COLUMNS = new Set(['path', '_mtime', '_ctime', '_size', '_rank', '_parse_error', 'content', 'links', 'sections']);

// YAML error codes whose recovery is unambiguous, so the parse is accepted rather than
// quarantined. Only one qualifies: YAML 1.2 reserves `@` and `` ` `` at the start of a plain
// scalar for future use, so they can never be valid and the text can only be what was typed
// (`aliases: [@handle]` -> ["@handle"]). Every other code has a second reading -- an unquoted
// `:` swallows the keys after it, an unquoted `[..](..)` drops the URL, a duplicate key picks
// one value in silence -- so it writes values nobody wrote.
const ACCEPTED_YAML_CODES = new Set(['BAD_SCALAR_START']);

export function normalizeText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

// SQLite's datetime() rejects a colonless offset (`-0800`) and a space separator, which ISO 8601
// allows and producers emit. A rejected date is invisible, not excluded: every comparison is NULL.
const ISO_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

// A value opening `YYYY-MM-DDT` was meant to be a datetime; prose never is. Reported when it
// cannot be normalized, so a typo surfaces on the next crawl instead of at some later audit.
const MEANT_AS_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d/;

export function looksLikeDatetime(value: string): boolean {
  return MEANT_AS_DATETIME.test(value);
}

// Punctuation only, never a timezone conversion: the offset survives, so substr(d,1,10) is still
// the local date. A shape that is not a real instant is left as written, and stays auditable.
export function normalizeDate(value: string): string {
  const m = ISO_DATETIME.exec(value);
  if (m === null) return value;
  const [, date, time, zone] = m;
  const digits = zone === undefined || zone === 'Z' ? '' : zone.replace(':', '');
  const offset = digits === '' ? (zone ?? '') : digits.length === 3 ? `${digits}:00` : `${digits.slice(0, 3)}:${digits.slice(3)}`;
  const normalized = `${date}T${time}${offset}`;
  return Number.isNaN(Date.parse(normalized)) ? value : normalized;
}

// Storage class follows the YAML scalar. Booleans store as 1/0, so `WHERE flag = 1` matches
// and `WHERE flag = 'true'` cannot; `map` prints observed types so the mismatch is visible.
export function mapValue(value: unknown): string | number | bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return BigInt(value ? 1 : 0);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : value;
  if (typeof value === 'string') return normalizeDate(value);
  return JSON.stringify(value);
}

// The delimiter split is all this package used gray-matter for.
export function splitFrontmatter(raw: string): { fm: string | null; body: string } {
  const open = raw.match(/^---\r?\n/);
  if (!open) return { fm: null, body: raw };
  const rest = raw.slice(open[0].length);
  const close = rest.match(/^---\r?(\n|$)/m);
  if (!close || close.index === undefined) return { fm: null, body: raw };
  return { fm: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

// A well-formed document can still hold a value nobody meant: `created: {{date}}` is valid
// YAML for a flow map used as a mapping key, so it raises no error and stores
// {"{ date }": null}. No error code can catch that, but yaml notices the stringified key, so
// this reports it with the path instead (yaml's own warning has none, fires once per document,
// and is what trains readers to discard stderr).
function warnStringifiedKeys(relPath: string, doc: ReturnType<typeof parseDocument>, warnings: string[]): void {
  let found = false;
  // Nested, not top level: `created: {{date}}` puts the collection key one level down, inside
  // the flow map that `{{...}}` parses as.
  visit(doc, {
    Pair(_key, pair) {
      if (!isCollection(pair.key)) return undefined;
      found = true;
      return visit.BREAK;
    },
  });
  // One per file: a template repeats the same mistake on every field it stamps.
  if (found) warnings.push(`warning: ${relPath} frontmatter has a key that is itself a list or mapping, stored as text; this is usually an unrendered template placeholder like {{date}}`);
}

// Accept a clean parse, and one whose every error is unambiguous (ACCEPTED_YAML_CODES).
// Anything else is quarantined: no frontmatter columns at all, and `_parse_error` carries the
// reason. Recovering it would write values nobody wrote, which is worse than absence because
// no query can see it. The file is still indexed -- content, links and sections never touch
// frontmatter -- so a broken note stays searchable while it is being hunted for.
// yaml's message continues onto a source excerpt, so the first line is the sentence -- minus
// the colon that introduced the part being dropped.
function firstLine(message: string): string {
  return message.split('\n')[0].replace(/:\s*$/, '');
}

export function parseFrontmatter(relPath: string, fm: string, warnings: string[]): { data: Record<string, unknown>; parseError: string | null } {
  // logLevel silences yaml's own pathless warnings; warnStringifiedKeys re-reports the one
  // that carries information, with the file it came from.
  const doc = parseDocument(fm, { logLevel: 'silent' });
  const refused = doc.errors.filter((err) => !ACCEPTED_YAML_CODES.has(err.code));
  if (refused.length > 0) {
    const detail = refused.length > 1 ? ` (and ${refused.length - 1} more)` : '';
    const parseError = `${firstLine(refused[0].message)}${detail}`;
    warnings.push(`warning: ${relPath} frontmatter did not parse, so none of it is indexed: ${parseError}`);
    return { data: {}, parseError };
  }

  let data: unknown;
  try {
    data = doc.toJS();
  } catch (err) {
    // Reaches here with doc.errors empty: `title: **Bold**` parses, then opens an alias on
    // materialisation. An empty error list is not a successful parse.
    const parseError = firstLine((err as Error).message);
    warnings.push(`warning: ${relPath} frontmatter did not parse, so none of it is indexed: ${parseError}`);
    return { data: {}, parseError };
  }

  if (data === null || data === undefined) return { data: {}, parseError: null };
  if (typeof data !== 'object' || Array.isArray(data)) {
    const parseError = 'frontmatter is not a key-value mapping';
    warnings.push(`warning: ${relPath} ${parseError}; none of it is indexed`);
    return { data: {}, parseError };
  }
  warnStringifiedKeys(relPath, doc, warnings);
  return { data: data as Record<string, unknown>, parseError: null };
}
