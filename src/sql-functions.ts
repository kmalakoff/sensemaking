import type { DatabaseSync } from 'node:sqlite';
import { segmentMatch } from './segment.ts';

// has(field, value): JSON-array field -> membership, string field -> substring, NULL -> false.
export function registerFunctions(db: DatabaseSync, segmenting: boolean): void {
  db.function('has', { deterministic: true, varargs: false }, (field: unknown, value: unknown): number => {
    if (field === null || field === undefined) return 0;

    const needle = String(value);

    if (typeof field === 'string') {
      if (field.startsWith('[')) {
        try {
          const parsed = JSON.parse(field);
          if (Array.isArray(parsed)) {
            return parsed.some((item) => String(item) === needle) ? 1 : 0;
          }
        } catch {}
      }
      return field.includes(needle) ? 1 : 0;
    }

    return String(field).includes(needle) ? 1 : 0;
  });

  // Raw `content MATCH '<unspaced text>'` cannot be rewritten behind the author's back, and
  // matches nothing, so the same transform is available to hand-written SQL by name. `segmenting`
  // is the same config predicate commands.ts's search() gates on (contentTokenize(cfg) ===
  // undefined), passed in by open() rather than read back from persisted state.
  db.function('segment', { deterministic: true, varargs: false }, (terms: unknown): string => {
    const text = terms === null || terms === undefined ? '' : String(terms);
    return segmenting ? segmentMatch(text) : text;
  });
}
