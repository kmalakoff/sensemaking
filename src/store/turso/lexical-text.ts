import { stemmer } from 'stemmer';
import { foldForSearch, searchTokens } from '../../text/segment.ts';

export function stemFolded(text: string): string {
  let out = '';
  let end = 0;
  for (const token of searchTokens(text)) {
    out += text.slice(end, token.start).replace(/[\u0027\u2019]/gu, ' ');
    out += token.unspaced ? token.text : stemmer(foldForSearch(token.text));
    end = token.end;
  }
  return out + text.slice(end).replace(/[\u0027\u2019]/gu, ' ');
}
