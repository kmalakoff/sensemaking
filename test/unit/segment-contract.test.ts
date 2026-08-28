import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { segmentField, segmentMatch } from '../../src/segment.ts';

// A small alphabet exercising every construct segment.ts's contract has to handle: two Han base
// characters (so a run can be more than one grapheme), one hiragana, one Thai base+combining-mark
// cluster (one grapheme, two code points), CJK punctuation whose Script_Extensions keep it inside
// a run, a space, and one Latin letter.
const HAN1 = '数';
const HAN2 = '据';
const HIRAGANA = 'あ';
const THAI = 'ค้'; // consonant + MAI THO: one grapheme cluster
const PUNCTUATION = '。';
const SPACE = ' ';
const LATIN = 'a';
const ALPHABET = [HAN1, HAN2, HIRAGANA, THAI, PUNCTUATION, SPACE, LATIN];

// Every string this alphabet forms, length 1 through MAX_LEN: 19,607 strings at 5, enumerated
// and indexed in ~0.3s and queried in ~1s (measured) -- comfortably under the ~10s budget.
const MAX_LEN = 5;

function enumerate(alphabet: string[], maxLen: number): string[] {
  const out: string[] = [];
  let level = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const prefix of level) for (const sym of alphabet) next.push(prefix + sym);
    out.push(...next);
    level = next;
  }
  return out;
}

const DOCS = enumerate(ALPHABET, MAX_LEN);
// The pure unspaced-script subset: grapheme-aligned and punctuation-free, so substring semantics
// is the whole claim (a query holding a space or 。 is expected to split into separate phrases;
// one holding the Latin letter never enters a run at all).
const PURE_UNSPACED = /^(?:数|据|あ|ค้)+$/;
const QUERIES = DOCS.filter((d) => PURE_UNSPACED.test(d));

function buildDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  // Production DDL shape (src/db/open.ts ensureSchema), standalone: the claim under test is
  // segmentField/segmentMatch against real FTS5, not the reconcile/scan pipeline around them.
  db.exec(`CREATE VIRTUAL TABLE content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = 'porter unicode61')`);
  const insert = db.prepare(`INSERT INTO content (rowid, title, summary, text, path, title_seg, summary_seg, text_seg) VALUES (?, '', '', ?, ?, '', '', ?)`);
  DOCS.forEach((d, i) => insert.run(i + 1, d, `p${i}`, segmentField(d)));
  return db;
}

describe('segment contract: exhaustive small-scope enumeration against String.prototype.includes', () => {
  const db = buildDb();
  // What search() actually runs (src/commands/search.ts matchSql): MATCH with the rewritten
  // query, which an unqualified run now scopes to the sidecars itself (SIDECAR_COLUMNS).
  const matchAll = db.prepare('SELECT rowid FROM content WHERE content MATCH ?');

  it(`checks ${QUERIES.length} pure unspaced-script substrings against ${DOCS.length} documents`, () => {
    let falseNegatives = 0;
    let falsePositives = 0;
    const negExamples: string[] = [];
    const posExamples: string[] = [];

    for (const q of QUERIES) {
      const rewritten = segmentMatch(q);
      const expected = new Set(DOCS.filter((d) => d.includes(q)));
      const gotDocs = new Set((matchAll.all(rewritten) as Array<{ rowid: number }>).map((r) => DOCS[r.rowid - 1]));

      for (const d of expected) {
        if (!gotDocs.has(d)) {
          falseNegatives++;
          if (negExamples.length < 5) negExamples.push(`${JSON.stringify(q)} missed ${JSON.stringify(d)}`);
        }
      }

      for (const d of gotDocs) {
        if (expected.has(d)) continue;
        falsePositives++;
        if (posExamples.length < 5) posExamples.push(`${JSON.stringify(q)} -> ${JSON.stringify(d)}`);
      }
    }

    assert.equal(falseNegatives, 0, `false negatives (recall must be exact):\n${negExamples.join('\n')}`);
    // An unqualified run now targets only the segmented sidecars (src/segment.ts SIDECAR_COLUMNS),
    // so raw title/summary/text -- where unicode61 drops punctuation and reads it the same as a
    // real gap -- are never checked by the rewritten query at all; zero false positives anywhere.
    assert.equal(falsePositives, 0, `false positives:\n${posExamples.join('\n')}`);
  });
});
