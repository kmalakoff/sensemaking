import type { DatabaseSync } from 'node:sqlite';
import { segmentMatch } from '../../text/segment.ts';
import { basenameImpl, hasImpl } from '../sql-functions.ts';

export function registerFunctions(db: DatabaseSync, segmenting: boolean): void {
  db.function('has', { deterministic: true, varargs: false }, hasImpl);

  db.function('basename', { deterministic: true, varargs: true }, basenameImpl);

  // Raw `content MATCH '<unspaced text>'` cannot be rewritten behind the author's back and matches
  // nothing, so the same transform is available to hand-written SQL by name. `segmenting` is the same config predicate commands.ts's search() gates on (contentTokenize(cfg) === undefined), passed in by open().
  db.function('segment', { deterministic: true, varargs: false }, (terms: unknown): string => {
    const text = terms === null || terms === undefined ? '' : String(terms);
    return segmenting ? segmentMatch(text) : text;
  });
}
