import type { Block } from '../chunk/index.ts';
import { extractText, parse } from '../chunk/index.ts';
import { normalizeText } from '../scan/frontmatter.ts';

// Flat prose from blocks a caller already parsed, via the same extractText the chunker uses
// (src/chunk) -- words and vectors read one definition of "the prose of this note".
export function textFromBlocks(blocks: Block[]): string {
  const text = blocks
    .map((block) => extractText(block.node))
    .filter((s) => s.length > 0)
    .join('\n');
  return normalizeText(text);
}

// Thin parse + delegate, for callers with no blocks of their own already.
export function stripText(value: string): string {
  return textFromBlocks(parse(value));
}
