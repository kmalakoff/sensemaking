import { stemmer } from 'stemmer';

// Word boundaries FTS5's tokenizers cannot find on their own. Contract: seg(query) must appear in
// seg(document) for any substring query; word mode is context-dependent and breaks that, so grapheme mode (UAX #29) is used.

// Scripts written without word spaces: a closed set of writing systems.
// Script_Extensions, not Script: the katakana long-vowel mark ー is Script=Common.
export const UNSPACED_SCRIPTS = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Thai}\\p{scx=Khmer}\\p{scx=Lao}\\p{scx=Myanmar}';
// A run is script BASE characters with their combining marks attached; a bare mark after a
// Latin letter (decomposed é) never starts one.
const RUN = new RegExp(`((?:[${UNSPACED_SCRIPTS}]\\p{M}*)+)`, 'gu');
const HAS_RUN = new RegExp(`[${UNSPACED_SCRIPTS}]`, 'u');

// Whether text holds a script that marks no word boundaries, the predicate every store's
// sidecar population and query split turns on.
export function hasUnspacedRun(text: string): boolean {
  return HAS_RUN.test(text);
}

export interface SearchToken {
  text: string;
  start: number;
  end: number;
  unspaced: boolean;
}

// Search tokens share the native separator contract: letters, marks, and numbers form tokens;
// underscore, apostrophe, and hyphen separate them. Unspaced-script runs stay whole so callers
// can apply substring semantics, while adjacent Latin text still gets its own token.
export function searchTokens(text: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)) {
    const start = match.index;
    const end = start + match[0].length;
    let cursor = start;
    for (const run of text.slice(start, end).matchAll(RUN)) {
      const runStart = start + run.index;
      if (runStart > cursor) tokens.push({ text: text.slice(cursor, runStart), start: cursor, end: runStart, unspaced: false });
      const runEnd = runStart + run[0].length;
      tokens.push({ text: run[0], start: runStart, end: runEnd, unspaced: true });
      cursor = runEnd;
    }
    if (cursor < end) tokens.push({ text: text.slice(cursor, end), start: cursor, end, unspaced: false });
  }
  return tokens;
}

// Phrase membership is checked after native ranking. A CJK token matches inside one authored
// run; Latin tokens compare folded Porter stems. Each call scans one field once per candidate.
export function matchesSearchPhrase(text: string, phrase: SearchToken[]): boolean {
  const haystack = searchTokens(text);
  if (phrase.length === 0 || haystack.length < phrase.length) return false;
  for (let start = 0; start <= haystack.length - phrase.length; start++) {
    let matches = true;
    for (let i = 0; i < phrase.length; i++) {
      const query = phrase[i];
      const authored = haystack[start + i];
      if (query.unspaced) {
        if (!authored.unspaced || !authored.text.includes(query.text)) matches = false;
      } else if (authored.unspaced || stemmer(foldForSearch(authored.text)) !== stemmer(foldForSearch(query.text))) {
        matches = false;
      }
      if (!matches) break;
    }
    if (matches) return true;
  }
  return false;
}

// Character spans of unspaced-script runs in text, the same boundary the index segments on --
// the snippet marker uses this to keep substring semantics inside a run and word/stem matching outside it.
export function unspacedRuns(text: string): Array<{ start: number; end: number }> {
  return Array.from(text.matchAll(RUN), (m) => ({ start: m.index, end: m.index + m[0].length }));
}
// Grapheme clusters, ECMA-402/UAX #29: base char plus its marks, ZWJ sequences, Hangul jamo.
// Built on first use and kept: construction is 6.6 ms, and a tree with no unspaced-script run
// never segments at all, so no command pays it at module load.
let graphemeSegmenter: Intl.Segmenter | undefined;
// unicode61 drops Unicode punctuation as a separator. Some of it (。、「」) has Script_Extensions
// into an unspaced script, so RUN keeps it -- a grapheme matching this becomes a split point.
const PUNCTUATION = /\p{P}/u;
// Token barrier between separate runs (or a punctuation split within one) so their graphemes
// are never phrase-adjacent. U+A7F7: a letter (so FTS5 keeps it as a token) no one types.
const BARRIER = 'ꟷ';

function graphemes(run: string): string[] {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(graphemeSegmenter.segment(run), (s) => s.segment);
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

// Index side: '' when the field has no unspaced-script run. Otherwise each run explodes into
// its graphemes, barrier-delimited from its neighbors and from a punctuation split within itself.
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

// Raw title/summary/text drop punctuation as unicode61's token separator, so `数数` and `数。数`
// falsely match there; only the barriered `_seg` columns are safe from it, hence this fallback target.
const SIDECAR_COLUMNS = '{title_seg summary_seg text_seg}:';

// A run's punctuation-free groups, each its own quoted phrase (bare token if one grapheme),
// space-joined -- the same split points segmentField barriers, so query and index agree.
function runQuery(run: string, columnPrefix: string): string {
  return splitOnPunctuation(run)
    .map((g) => `${columnPrefix}${g.length > 1 ? `"${g.join(' ')}"` : g[0]}`)
    .join(' ');
}

// Query side: each unspaced run becomes phrases of its graphemes, matching segmentField. A
// qualifier maps to its `_seg` column; unqualified maps to all three (SIDECAR_COLUMNS).
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

// FTS tokenizers compare letters without combining marks. Keep the authored string for output and
// offsets, but use this key when JS needs to compare a matched word to its source segment.
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}
