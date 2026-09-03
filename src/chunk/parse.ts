import Module from 'node:module';
import type { RootContent } from 'mdast';
import { extractText } from './extract.ts';
import type { Block, BlockType } from './types.ts';

// Tier-2, as embed/static.ts: the parser's packages cost ~19 ms to load and a warm tree never
// parses, so every store-opening command paid for them until a file actually changed.
const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

const BLOCK_TYPES: Partial<Record<RootContent['type'], BlockType>> = {
  heading: 'heading',
  paragraph: 'paragraph',
  code: 'code',
  table: 'table',
  list: 'list',
  blockquote: 'blockquote',
};

type FromMarkdown = typeof import('mdast-util-from-markdown').fromMarkdown;
type Parser = { fromMarkdown: FromMarkdown; options: NonNullable<Parameters<FromMarkdown>[1]> };
let cached: Parser | undefined;

// Imported individually, not via micromark-extension-gfm/mdast-util-gfm: those bundles also pull
// in gfm-tagfilter, an HTML sanitizer this library never uses (no htmlExtensions call anywhere).
function parser(): Parser {
  if (cached) return cached;
  const { fromMarkdown } = _require('mdast-util-from-markdown') as typeof import('mdast-util-from-markdown');
  const { gfmAutolinkLiteralFromMarkdown } = _require('mdast-util-gfm-autolink-literal') as typeof import('mdast-util-gfm-autolink-literal');
  const { gfmFootnoteFromMarkdown } = _require('mdast-util-gfm-footnote') as typeof import('mdast-util-gfm-footnote');
  const { gfmStrikethroughFromMarkdown } = _require('mdast-util-gfm-strikethrough') as typeof import('mdast-util-gfm-strikethrough');
  const { gfmTableFromMarkdown } = _require('mdast-util-gfm-table') as typeof import('mdast-util-gfm-table');
  const { gfmTaskListItemFromMarkdown } = _require('mdast-util-gfm-task-list-item') as typeof import('mdast-util-gfm-task-list-item');
  const { gfmAutolinkLiteral } = _require('micromark-extension-gfm-autolink-literal') as typeof import('micromark-extension-gfm-autolink-literal');
  const { gfmFootnote } = _require('micromark-extension-gfm-footnote') as typeof import('micromark-extension-gfm-footnote');
  const { gfmStrikethrough } = _require('micromark-extension-gfm-strikethrough') as typeof import('micromark-extension-gfm-strikethrough');
  const { gfmTable } = _require('micromark-extension-gfm-table') as typeof import('micromark-extension-gfm-table');
  const { gfmTaskListItem } = _require('micromark-extension-gfm-task-list-item') as typeof import('micromark-extension-gfm-task-list-item');
  cached = {
    fromMarkdown,
    options: {
      extensions: [gfmAutolinkLiteral(), gfmFootnote(), gfmStrikethrough(), gfmTable(), gfmTaskListItem()],
      mdastExtensions: [gfmAutolinkLiteralFromMarkdown(), gfmFootnoteFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTableFromMarkdown(), gfmTaskListItemFromMarkdown()],
    },
  };
  return cached;
}

// Top-level blocks of a markdown body, typed and line-extent bounded from mdast's own
// node.position (never a regex guess). GFM extensions add tables, task lists, footnotes, strikethrough.
export function parse(body: string): Block[] {
  const { fromMarkdown, options } = parser();
  const tree = fromMarkdown(body, options);
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
