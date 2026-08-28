// Word boundaries FTS5's tokenizers cannot find on their own.
//
// Segmentation is context-free: seg(query) appears inside seg(document) whenever the query is
// a substring of the document. That is the contract -- substring semantics, what `grep` and
// `LIKE '%..%'` give -- and it is what makes index and query agree on every input, always.
// Intl.Segmenter's word mode is context-dependent (`东京都政府` splits as `东 | 京都 | 政府`
// while the query `东京` splits as one word) and is rejected for that reason. Its grapheme
// mode has no such dependency -- UAX #29 cluster boundaries never look past adjacent
// characters -- so grapheme mode is used below; no dictionary, no word mode.

// Scripts written without word spaces: a closed set of writing systems.
// Script_Extensions, not Script: the katakana long-vowel mark ー is Script=Common.
export const UNSPACED_SCRIPTS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Khmer}\\p{scx=Lao}\\p{scx=Myanmar}';
// A run is script BASE characters with their combining marks attached; a bare mark after a
// Latin letter (decomposed é) never starts one.
const RUN = new RegExp(`((?:[${UNSPACED_SCRIPTS}]\\p{M}*)+)`, 'gu');
const HAS_RUN = new RegExp(`[${UNSPACED_SCRIPTS}]`, 'u');
// Grapheme clusters, ECMA-402/UAX #29: base char plus its marks, ZWJ sequences, Hangul jamo.
// Built once (construction cost amortizes) and used for both index and query splitting.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// unicode61 drops Unicode punctuation as a separator. Some of it (。、「」) has Script_Extensions
// into an unspaced script, so RUN keeps it -- a grapheme matching this becomes a split point.
const PUNCTUATION = /\p{P}/u;
// Token barrier between separate runs (or a punctuation split within one) so their graphemes
// are never phrase-adjacent. U+A7F7: a letter (so FTS5 keeps it as a token) no one types.
const BARRIER = 'ꟷ';

function graphemes(run: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(run), (s) => s.segment);
}

// A run's graphemes, cut into punctuation-free groups at every punctuation grapheme (dropped,
// matching unicode61). The one place punctuation is classified, so index and query agree.
function splitOnPunctuation(run: string): string[][] {
  const groups: string[][] = [[]];
  for (const g of graphemes(run)) {
    if (PUNCTUATION.test(g)) groups.push([]);
    else groups[groups.length - 1].push(g);
  }
  return groups.filter((g) => g.length > 0);
}

// Index side: '' when the field has no unspaced-script run (the common case, paid for by
// nothing). Otherwise each run explodes into its graphemes, barrier-delimited from its
// neighbors and from a punctuation split within itself.
export function segmentField(text: string): string {
  if (!HAS_RUN.test(text)) return '';
  const out = text.replace(RUN, (run) => {
    const body = splitOnPunctuation(run)
      .map((g) => g.join(' '))
      .join(` ${BARRIER} `);
    return ` ${BARRIER} ${body} ${BARRIER} `;
  });
  return out.replace(/\s+/g, ' ').trim();
}

// A `title:`/`summary:`/`text:` qualifier directly before a run that is about to become a
// quoted grapheme phrase, so the rewrite can retarget it at the matching `_seg` column.
const QUALIFIER = /(^|[\s(])(-?)(title|summary|text)\s*:\s*$/;

// An unqualified run's target: raw title/summary/text drop punctuation as unicode61's token
// separator, so two adjacent single-grapheme phrase positions match across punctuation the same
// as across a real gap (`数数` vs `数。数`) -- a false positive only the barriered `_seg` columns
// are safe from. FTS5's column-set filter, not parens+OR, so the group still composes under
// AND/OR/NOT/juxtaposition exactly like the single-column qualifier form below.
const SIDECAR_COLUMNS = '{title_seg summary_seg text_seg}:';

// A run's punctuation-free groups, each its own quoted phrase (bare token if one grapheme),
// space-joined -- the same split points segmentField barriers, so query and index agree.
function runQuery(run: string, columnPrefix: string): string {
  return splitOnPunctuation(run)
    .map((g) => `${columnPrefix}${g.length > 1 ? `"${g.join(' ')}"` : g[0]}`)
    .join(' ');
}

// Query side: each unspaced run becomes phrases of its graphemes, matching how segmentField
// indexed it. A qualifier ahead of such a run maps to its `_seg` column; unqualified maps to all
// three (SIDECAR_COLUMNS), since raw columns cannot express the contract. An author's own quoted
// phrase is their explicit escape hatch to FTS5's native syntax, and passes through byte-identical.
export function segmentMatch(terms: string): string {
  if (!HAS_RUN.test(terms)) return terms;
  let out = '';
  let quoted = false;
  const pieces = terms.split(RUN); // split keeps captured runs at odd indices
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 0) {
      for (const ch of pieces[i]) if (ch === '"') quoted = !quoted;
      out += pieces[i];
      continue;
    }
    if (quoted) {
      out += pieces[i]; // an author's phrase is matched as written
      continue;
    }
    const m = out.match(QUALIFIER);
    if (m) {
      out = `${out.slice(0, m.index)}${m[1]}${runQuery(pieces[i], `${m[2]}${m[3]}_seg:`)}`;
    } else {
      out += runQuery(pieces[i], SIDECAR_COLUMNS);
    }
  }
  return out;
}
