import posix from 'node:path/posix';

// has(field, value) / basename(path, suffix): the two sense-supplied SQL functions with no
// engine-specific pieces, registered identically by each store instead of a hand-copied one.

// JSON-array field -> membership, string field -> substring, NULL -> false.
export function hasImpl(field: unknown, value: unknown): number {
  if (field === null || field === undefined) return 0;
  const needle = String(value);
  if (typeof field === 'string') {
    if (field.startsWith('[')) {
      try {
        const parsed = JSON.parse(field);
        if (Array.isArray(parsed)) return parsed.some((item) => String(item) === needle) ? 1 : 0;
      } catch {}
    }
    return field.includes(needle) ? 1 : 0;
  }
  return String(field).includes(needle) ? 1 : 0;
}

// Unix basename(path, suffix?): the filename, minus suffix when it ends with one. Neither engine
// has a filename function of its own, and LIKE tricks that fake one also match folder names.
export function basenameImpl(path: unknown, suffix?: unknown): string | null {
  if (path === null || path === undefined) return null;
  const name = posix.basename(String(path));
  const tail = suffix === null || suffix === undefined ? '' : String(suffix);
  // POSIX: a suffix identical to the whole name is not removed (node's own basename strips it).
  return tail !== '' && tail !== name && name.endsWith(tail) ? name.slice(0, -tail.length) : name;
}
