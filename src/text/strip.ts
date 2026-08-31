import type { Block } from '../chunk/index.ts';
import { extractTexts, parse } from '../chunk/index.ts';
import { normalizeText } from '../scan/frontmatter.ts';

// Flat prose from blocks a caller already parsed, via the same extractor the chunker uses
// (src/chunk) -- words and vectors read one definition of "the prose of this note".
export function textFromBlocks(blocks: Block[]): string {
  return normalizeText(extractTexts(blocks.map((block) => block.node)));
}

// Thin parse + delegate, for callers with no blocks of their own already.
export function stripText(value: string): string {
  return textFromBlocks(parse(value));
}
