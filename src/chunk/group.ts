import { UNSPACED_SCRIPTS } from '../text/segment.ts';
import { extractText } from './extract.ts';
import { parse } from './parse.ts';
import type { Block, BlockType, Chunk, ChunkOptions } from './types.ts';

export const DEFAULT_TARGET_TOKENS = 500;
const PGC_GROUP_SIZE = 2;
const OVERSIZE_TRIGGER_MULTIPLE = 2;

// D5: segment.ts's unspaced-script set packs close to one token per character; Hangul is
// spaced but still token-dense, added here as a conservative bound (one Unicode set, one home).
const DENSE_SCRIPT = new RegExp(`[${UNSPACED_SCRIPTS}\\p{scx=Hangul}]`, 'u');

// D5's size estimate: dense-script graphemes 1:1, everything else at 4 chars/token.
export function estimateTokens(text: string): number {
  let dense = 0;
  let other = 0;
  for (const ch of text) {
    if (DENSE_SCRIPT.test(ch)) dense++;
    else other++;
  }
  return dense + other / 4;
}

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
  // true for a sub-line split piece (finalizePiece's splitLineText branch): its text is already
  // the active mode's final text for its own slice of the line, not the whole line, so group()'s
  // extent-based raw re-slice (startLine === endLine for every sibling sub-piece) must not touch it.
  final?: boolean;
}

function finalize(parts: Part[]): (Chunk & { final?: boolean }) | undefined {
  if (parts.length === 0) return undefined;
  const first = parts[0];
  const last = parts[parts.length - 1];
  return { startLine: first.startLine, endLine: last.endLine, text: parts.map((p) => p.text).join('\n'), final: parts.some((p) => p.final) };
}

const NEWLINE_TOKENS = estimateTokens('\n');
const SENTENCE_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'sentence' });
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

function segmentsOf(text: string, segmenter: Intl.Segmenter): string[] {
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

// A single line's text, still over working after rule 5's line-split can't reduce a lone line
// (the CJK case, one sentence-dense line with no newlines), falls back to Intl.Segmenter sentence
// boundaries, then word boundaries for any one sentence still over working. Never splits inside a
// grapheme either way (both are ECMA-402, the same proven component segment.ts uses for
// graphemes). Mode-agnostic: the caller decides whether `text` is the raw line or its extracted
// flavor -- this only packs whatever text it is given.
function splitLineText(text: string, working: number): string[] {
  const sentences = segmentsOf(text, SENTENCE_SEGMENTER);
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
      out.push(...pack(segmentsOf(sentence, WORD_SEGMENTER), working));
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

// An atomic block's (code/table/list) piece is always a raw line slice: re-parsing a table's
// later pieces without their header/delimiter rows demotes them to paragraph text. A non-atomic
// piece is a raw line slice too when raw mode requested it; extracted mode re-parses and resolves
// flavor as before.
function piece(pieceLines: string[], startLine: number, endLine: number, blockType: BlockType, textMode: 'extracted' | 'raw'): Part {
  const text =
    ATOMIC_TYPES.has(blockType) || textMode === 'raw'
      ? pieceLines.join('\n')
      : parse(pieceLines.join('\n'))
          .map((b) => extractText(b.node))
          .join('\n');
  return { startLine, endLine, text };
}

// A piece over working size that came from exactly one source line cannot be reduced by another
// line-boundary pass (rule 5's gap); it is sliced instead, at sentence then word boundaries, over
// the mode-resolved text piece() already produced -- so raw mode packs the raw line and extracted
// mode packs its flavor-resolved text. Extents collapse to that one line for every sub-piece (F5:
// re-derivation is by index over chunk()'s own deterministic output, not by a unique line range
// per piece); `final` flags each sub-piece so group() knows not to re-derive its text from that
// shared extent.
function finalizePiece(pieceLines: string[], startLine: number, endLine: number, working: number, blockType: BlockType, textMode: 'extracted' | 'raw'): Part[] {
  const p = piece(pieceLines, startLine, endLine, blockType, textMode);
  if (pieceLines.length === 1 && estimateTokens(p.text) > working) {
    return splitLineText(p.text, working).map((text) => ({ startLine, endLine, text, final: true }));
  }
  return [p];
}

// A block over 2x working size splits at line boundaries into pieces each <= working size,
// never mid-line. `seed`: pending tokens (a heading) the first piece must join, checked against
// the limit too.
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
  // A `final` chunk (a sub-line split) already carries its own slice's raw text -- re-slicing by
  // extent would return the whole shared source line instead, once per sub-piece.
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
