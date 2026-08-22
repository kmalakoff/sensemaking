// Word boundaries FTS5's tokenizers cannot find on their own.
//
// Segmentation is context-free: seg(query) appears inside seg(document) whenever the query is
// a substring of the document. That is the contract -- substring semantics, what `grep` and
// `LIKE '%..%'` give -- and it is what makes index and query agree on every input, always.
// Earlier attempts used ICU word segmentation (Intl.Segmenter), which is context-dependent:
// `东京都政府` splits as `东 | 京都 | 政府` while the query `东京` splits as one word, so the
// index and the query disagree about identical text. No ICU here. No dictionary.

// Scripts written without word spaces: a closed set of writing systems.
// Script_Extensions, not Script: the katakana long-vowel mark ー is Script=Common.
const SCRIPTS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Khmer}\\p{scx=Lao}\\p{scx=Myanmar}';
// A run is script BASE characters with their combining marks attached; a bare mark after a
// Latin letter (decomposed é) never starts one.
const RUN = new RegExp(`((?:[${SCRIPTS}]\\p{M}*)+)`, 'gu');
const HAS_RUN = new RegExp(`[${SCRIPTS}]`, 'u');
// Grapheme = base char plus its marks. Context-free: index and query can never disagree.
const GRAPHEME = /(\P{M}\p{M}*)/gu;
// Token barrier between separate runs so their graphemes are never phrase-adjacent.
// U+A7F7: a letter (so FTS5 keeps it as a token) that no one types into a search.
const BARRIER = 'ꟷ';

function graphemes(run: string): string[] {
  return run.match(GRAPHEME) ?? [];
}

// Index side: '' when the field has no unspaced-script run (the common case, paid for by
// nothing). Otherwise each run explodes into its graphemes, barrier-delimited from its
// neighbors so graphemes from separate runs are never phrase-adjacent, and whitespace collapses.
export function segmentField(text: string): string {
  if (!HAS_RUN.test(text)) return '';
  const out = text.replace(RUN, (run) => ` ${BARRIER} ${graphemes(run).join(' ')} ${BARRIER} `);
  return out.replace(/\s+/g, ' ').trim();
}

// A `title:`/`summary:`/`text:` qualifier directly before a run that is about to become a
// quoted grapheme phrase, so the rewrite can retarget it at the matching `_seg` column.
const QUALIFIER = /(^|[\s(])(-?)(title|summary|text)\s*:\s*$/;

// Query side: each unspaced run becomes a quoted phrase of its graphemes, matching how
// segmentField indexed it. A qualifier ahead of such a run maps to its `_seg` column, since
// segmented text lives only there. An author's own quoted phrase, and everything else, pass
// through byte-identical.
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
    const g = graphemes(pieces[i]);
    const phrase = g.length > 1 ? `"${g.join(' ')}"` : g[0];
    const m = out.match(QUALIFIER);
    if (m) {
      out = `${out.slice(0, m.index)}${m[1]}${m[2]}${m[3]}_seg:${phrase}`;
    } else {
      out += phrase;
    }
  }
  return out;
}
