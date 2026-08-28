import type { RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { extractText } from './extract.ts';
import type { Block, BlockType } from './types.ts';

const BLOCK_TYPES: Partial<Record<RootContent['type'], BlockType>> = {
  heading: 'heading',
  paragraph: 'paragraph',
  code: 'code',
  table: 'table',
  list: 'list',
  blockquote: 'blockquote',
};

// Top-level blocks of a markdown body, typed and line-extent bounded. Extents come from
// mdast's own node.position, never a regex guess at where a block starts or ends; GFM adds
// tables, task lists, footnotes and strikethrough to the CommonMark set fromMarkdown parses.
export function parse(body: string): Block[] {
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return tree.children.map((node) => {
    const position = node.position;
    const block: Block = {
      type: BLOCK_TYPES[node.type] ?? 'other',
      startLine: position ? position.start.line : 1,
      endLine: position ? position.end.line : 1,
      node,
    };
    if (node.type === 'heading') {
      block.depth = node.depth;
      block.text = extractText(node);
    }
    return block;
  });
}
