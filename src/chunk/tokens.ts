import { UNSPACED_SCRIPTS } from '../text/segment.ts';

export const DEFAULT_TARGET_TOKENS = 500;

// D5: segment.ts's unspaced-script set packs close to one token per character; Hangul is
// spaced but still token-dense and sits in this set as a conservative bound (one Unicode set, one home).
const DENSE_SCRIPT = new RegExp(`[${UNSPACED_SCRIPTS}\\p{scx=Hangul}]`, 'u');

// D5's size estimate: dense-script graphemes 1:1, everything else at 4 chars/token.
export function estimateTokens(text: string): number {
  let dense = 0;
  let other = 0;
  for (const ch of text) {
    if (DENSE_SCRIPT.test(ch)) dense++;
    else other++;
  }
  return dense + other / 4;
}
