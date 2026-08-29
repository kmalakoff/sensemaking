import type { RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
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

// The five extensions extract.ts/group.ts actually consume, imported individually rather than
// through micromark-extension-gfm/mdast-util-gfm: those bundles also pull in gfm-tagfilter,
// an HTML-serialization sanitizer this library never uses (no htmlExtensions call anywhere).
// micromark and mdast-util-from-markdown each already flatten an extensions array themselves,
// so no combine-extensions helper is needed here.
const EXTENSIONS = [gfmAutolinkLiteral(), gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()];
const MDAST_EXTENSIONS = [gfmAutolinkLiteralFromMarkdown(), gfmFootnoteFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()];

// Top-level blocks of a markdown body, typed and line-extent bounded. Extents come from
// mdast's own node.position, never a regex guess at where a block starts or ends; GFM adds
// tables, task lists, footnotes and strikethrough to the CommonMark set fromMarkdown parses.
export function parse(body: string): Block[] {
  const tree = fromMarkdown(body, { extensions: EXTENSIONS, mdastExtensions: MDAST_EXTENSIONS });
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
