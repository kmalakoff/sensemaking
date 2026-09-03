import { extractText } from './extract.ts';
import { parse } from './parse.ts';
import { DEFAULT_TARGET_TOKENS, estimateTokens } from './tokens.ts';
import type { Block, BlockType, Chunk, ChunkOptions } from './types.ts';

const PGC_GROUP_SIZE = 2;
const OVERSIZE_TRIGGER_MULTIPLE = 2;

interface ResolvedOptions {
  targetTokens: number;
  text: 'extracted' | 'raw';
}

function resolveOptions(opts?: ChunkOptions): ResolvedOptions {
  return {
    targetTokens: opts?.targetTokens ?? DEFAULT_TARGET_TOKENS,
    text: opts?.text ?? 'raw',
  };
}

// A heading of any depth ends the current scope and starts a new one (D1); the heading block
// itself is carried into the new scope, where it joins that scope's first group (F7/F10).
function splitScopes(blocks: Block[]): Block[][] {
  const scopes: Block[][] = [];
  let current: Block[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' && current.length > 0) {
      scopes.push(current);
      current = [];
    }
    current.push(block);
  }
  if (current.length > 0) scopes.push(current);
  return scopes;
}

interface Part {
  startLine: number;
  endLine: number;
  text: string;
  // True for a sub-line split piece: its text is already the final slice, not the whole line --
  // group()'s extent-based raw re-slice must not touch it (siblings share startLine === endLine).
  final?: boolean;
}

function finalize(parts: Part[]): (Chunk & { final?: boolean }) | undefined {
  if (parts.length === 0) return undefined;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return { startLine: first.startLine, endLine: last.endLine, text: parts.map((p) => p.text).join('\n'), final: parts.some((p) => p.final) };
}

const NEWLINE_TOKENS = estimateTokens('\n');
// Built on first use and kept: each construction is ~3.5 ms, and only an oversize block is ever
// split, so no command pays for a segmenter it never reaches.
const SEGMENTERS = new Map<string, Intl.Segmenter>();

function segmentsOf(text: string, granularity: 'sentence' | 'word'): string[] {
  let segmenter = SEGMENTERS.get(granularity);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(undefined, { granularity });
    SEGMENTERS.set(granularity, segmenter);
  }
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

// Greedily packs segments (already contiguous, tiling the source text with no gaps) into groups
// of at most `working` estimated tokens; a lone segment over `working` still stands alone.
function pack(segments: string[], working: number): string[] {
  const groups: string[] = [];
  let current = '';
  let tokens = 0;
  for (const segment of segments) {
    const segmentTokens = estimateTokens(segment);
    if (current.length > 0 && tokens + segmentTokens > working) {
      groups.push(current);
      current = '';
      tokens = 0;
    }
    current += segment;
    tokens += segmentTokens;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// Line-split alone can't shrink a lone dense line (the CJK case): falls back to sentence then
// word boundaries (Intl.Segmenter, the same grapheme-safe engine as segment.ts), mode-agnostic on `text`.
function splitLineText(text: string, working: number): string[] {
  const sentences = segmentsOf(text, 'sentence');
  const out: string[] = [];
  let current = '';
  let tokens = 0;
  const flush = () => {
    if (current.length > 0) {
      out.push(current);
      current = '';
      tokens = 0;
    }
  };
  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > working) {
      flush();
      out.push(...pack(segmentsOf(sentence, 'word'), working));
      continue;
    }
    if (current.length > 0 && tokens + sentenceTokens > working) flush();
    current += sentence;
    tokens += sentenceTokens;
  }
  flush();
  return out;
}

const ATOMIC_TYPES: ReadonlySet<BlockType> = new Set(['code', 'table', 'list']);

// Atomic (code/table/list) pieces are always a raw line slice: re-parsing a table's later pieces
// without their header/delimiter rows would demote them to paragraph text.
function piece(pieceLines: string[], startLine: number, endLine: number, blockType: BlockType, textMode: 'extracted' | 'raw'): Part {
  const text =
    ATOMIC_TYPES.has(blockType) || textMode === 'raw'
      ? pieceLines.join('\n')
      : parse(pieceLines.join('\n'))
          .map((b) => extractText(b.node))
          .join('\n');
  return { startLine, endLine, text };
}

// A one-line piece over working can't shrink via another line-boundary pass (rule 5's gap), so it
// splits at sentence/word boundaries instead; `final` stops group() re-deriving its text by extent (F5).
function finalizePiece(pieceLines: string[], startLine: number, endLine: number, working: number, blockType: BlockType, textMode: 'extracted' | 'raw'): Part[] {
  const p = piece(pieceLines, startLine, endLine, blockType, textMode);
  if (pieceLines.length === 1 && estimateTokens(p.text) > working) {
    return splitLineText(p.text, working).map((text) => ({ startLine, endLine, text, final: true }));
  }
  return [p];
}

// A block over 2x working size splits at line boundaries into pieces each <= working size, never
// mid-line. `seed`: pending tokens (e.g. a heading) the first piece must join, checked against the limit.
function splitOversizeBlock(lines: string[], startLine: number, endLine: number, working: number, blockType: BlockType, textMode: 'extracted' | 'raw', seed = 0): Part[] {
  const pieces: Part[] = [];
  let pieceLines: string[] = [];
  let pieceStart = startLine;
  let tokens = seed;
  for (let line = startLine; line <= endLine; line++) {
    const lineText = lines[line - 1];
    const sep = pieceLines.length > 0 || tokens > 0 ? NEWLINE_TOKENS : 0;
    const lineTokens = estimateTokens(lineText);
    if (pieceLines.length > 0 && tokens + sep + lineTokens > working) {
      pieces.push(...finalizePiece(pieceLines, pieceStart, line - 1, working, blockType, textMode));
      pieceLines = [];
      tokens = 0;
      pieceStart = line;
      pieceLines.push(lineText);
      tokens += lineTokens;
      continue;
    }
    pieceLines.push(lineText);
    tokens += sep + lineTokens;
  }
  if (pieceLines.length > 0) pieces.push(...finalizePiece(pieceLines, pieceStart, endLine, working, blockType, textMode));
  return pieces;
}

// One heading scope's groups (D1): a heading opens the first group, and an oversize block
// (rule 5, including an oversize heading) splits into pieces that each close their own group.
function groupScope(scopeBlocks: Block[], lines: string[], resolved: ResolvedOptions): (Chunk & { final?: boolean })[] {
  const working = resolved.targetTokens;
  const trigger = working * OVERSIZE_TRIGGER_MULTIPLE;
  const finished: (Chunk & { final?: boolean })[] = [];
  let parts: Part[] = [];
  let paragraphCount = 0;
  let tokens = 0;

  function close(): void {
    const group = finalize(parts);
    if (group) finished.push(group);
    parts = [];
    paragraphCount = 0;
    tokens = 0;
  }

  // tokens tracks the active text mode's own estimate (a newline between parts costs
  // NEWLINE_TOKENS too), so packing decisions size the text the chunk will actually ship as.
  function addPart(text: string, sizeText: string, startLine: number, endLine: number): void {
    tokens += (parts.length > 0 ? NEWLINE_TOKENS : 0) + estimateTokens(sizeText);
    parts.push({ startLine, endLine, text });
  }

  for (const block of scopeBlocks) {
    const raw = lines.slice(block.startLine - 1, block.endLine).join('\n');
    const blockTokens = estimateTokens(raw);

    if (blockTokens > trigger) {
      const seed = parts.length > 0 ? tokens : 0;
      for (const p of splitOversizeBlock(lines, block.startLine, block.endLine, working, block.type, resolved.text, seed)) {
        parts.push(p);
        close();
      }
      continue;
    }

    const extracted = extractText(block.node);
    const sizeText = resolved.text === 'raw' ? raw : extracted;

    if (block.type === 'heading') {
      addPart(extracted, sizeText, block.startLine, block.endLine);
      continue;
    }

    // The 2x-working invariant holds even under pgc's paper-faithful 2-paragraph pairing --
    // close first if the pair about to form would cross it.
    const pairOversize = parts.length > 0 && tokens + NEWLINE_TOKENS + blockTokens > trigger;
    if (pairOversize) close();

    addPart(extracted, sizeText, block.startLine, block.endLine);
    paragraphCount++;

    if (paragraphCount >= PGC_GROUP_SIZE) close();
  }
  close();

  return finished;
}

// Groups already-parsed blocks per opts (D1/D3), against the same body the blocks were parsed
// from (line lookups for oversize splitting).
export function group(blocks: Block[], body: string, opts?: ChunkOptions): Chunk[] {
  const resolved = resolveOptions(opts);
  const lines = body.split('\n');
  const chunks: (Chunk & { final?: boolean })[] = [];
  for (const scope of splitScopes(blocks)) chunks.push(...groupScope(scope, lines, resolved));
  // 'raw': the chunk's own source lines verbatim, replacing the flavor-resolved join above (D9).
  // A `final` chunk already carries its own slice's raw text; re-slicing by extent would return the whole shared line.
  const texted =
    resolved.text === 'raw'
      ? chunks.map((c) =>
          c.final
            ? c
            : {
                ...c,
                text: lines
                  .slice(c.startLine - 1, c.endLine)
                  .join('\n')
                  .trim(),
              }
        )
      : chunks;
  // A group can be all-blank (flavor-stripped to nothing, or a raw slice of pure syntax); it never produces a chunk.
  return texted.filter((c) => c.text.trim().length > 0).map((c) => ({ startLine: c.startLine, endLine: c.endLine, text: c.text }));
}
