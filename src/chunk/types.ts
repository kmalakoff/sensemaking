import type { RootContent } from 'mdast';

export type BlockType = 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'blockquote' | 'other';

// One top-level mdast node plus its 1-indexed source line extent, heading depth/text if any.
// `node` is the mdast node itself, so extract.ts and group.ts (W2) read the same parse.
export interface Block {
  type: BlockType;
  startLine: number;
  endLine: number;
  depth?: number;
  text?: string;
  node: RootContent;
}

export interface ChunkOptions {
  // D3/W3b: the pgc pairing cap and the sole owner lever (embed.chunkTokens); default 500.
  targetTokens?: number;
  // D9: 'raw' (source lines verbatim) is the shipped default; 'extracted' (flavor-resolved)
  // stays available for a future measured revisit, not currently shipped.
  text?: 'extracted' | 'raw';
}

// One grouped, extracted unit: 1-indexed line extent over the body, flavor-resolved text.
export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}
