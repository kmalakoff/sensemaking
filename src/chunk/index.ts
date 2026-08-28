import { group } from './group.ts';
import { parse } from './parse.ts';
import type { Block, Chunk, ChunkOptions } from './types.ts';

// Groups blocks a caller already parsed (e.g. scan/index.ts, sharing one parse with the FTS
// text path) against the same body they came from, per opts (D1/D3).
export function chunkFromBlocks(blocks: Block[], body: string, opts?: ChunkOptions): Chunk[] {
  return group(blocks, body, opts);
}

// Pure, deterministic function of file content; chunk semantics are version-stamped via
// CHUNK_VERSION (./version.ts). Algorithm and evidence: BENCHMARKING.md, "The chunking algorithm".
export function chunk(body: string, opts?: ChunkOptions): Chunk[] {
  return chunkFromBlocks(parse(body), body, opts);
}

export { extractText } from './extract.ts';
export { DEFAULT_TARGET_TOKENS, estimateTokens } from './group.ts';
export { parse } from './parse.ts';
export type { Block, BlockType, Chunk, ChunkOptions } from './types.ts';
export { CHUNK_VERSION } from './version.ts';
