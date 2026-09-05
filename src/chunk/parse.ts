import type { Token } from 'markdown-it';
import { extractText } from './extract.ts';
import { parser } from './parser.ts';
import type { Block, BlockType } from './types.ts';

// Opening token type to Block type. Everything else (rules, raw html, footnote definitions) is
// 'other', as mdast's BLOCK_TYPES mapped no entry for those nodes.
const BLOCK_TYPES: Record<string, BlockType> = {
  heading_open: 'heading',
  paragraph_open: 'paragraph',
  fence: 'code',
  code_block: 'code',
  table_open: 'table',
  ordered_list_open: 'list',
  bullet_list_open: 'list',
  blockquote_open: 'blockquote',
};

// Top-level blocks of a markdown body, typed and line-extent bounded from markdown-it's own
// token maps (never a regex guess). html and linkify on, with the footnote and task-list plugins.
export function parse(body: string): Block[] {
  const tokens = parser().parse(body, {});
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.nesting === 0) {
      blocks.push(makeBlock(BLOCK_TYPES[token.type] ?? 'other', tokens, i, i + 1, lines));
      i += 1;
    } else if (token.nesting === 1) {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        depth += tokens[j].nesting === 1 ? 1 : tokens[j].nesting === -1 ? -1 : 0;
        j += 1;
      }
      blocks.push(makeBlock(BLOCK_TYPES[token.type] ?? 'other', tokens, i, j, lines));
      i = j;
    } else {
      // Defensive: the balanced scan above consumes every close belonging to an open.
      i += 1;
    }
  }
  return blocks;
}

// 1-based inclusive extent from the min/max of the tokens' maps (0-based half-open); a block
// whose tokens carry no map (an empty footnote definition) falls back to line 1. Trailing
// blank lines trim so a list's endLine lands where mdast's position ended it.
function makeBlock(type: BlockType, tokens: Token[], i: number, j: number, lines: string[]): Block {
  let start = Infinity;
  let end = 0;
  for (let k = i; k < j; k++) {
    const map = tokens[k].map;
    if (map) {
      start = Math.min(start, map[0]);
      end = Math.max(end, map[1]);
    }
  }
  const startLine = Number.isFinite(start) ? start + 1 : 1;
  let endLine = end > start ? end : startLine;
  while (endLine > startLine && lines[endLine - 1].trim() === '') endLine--;
  const block: Block = { type, startLine, endLine, node: tokens.slice(i, j) };
  if (type === 'heading') {
    block.depth = Number(tokens[i].tag.slice(1));
    block.text = extractText(block);
  }
  return block;
}
