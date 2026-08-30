import type { Block, Chunk } from '../chunk/index.ts';
import { CHUNK_VERSION, chunkFromBlocks, parse } from '../chunk/index.ts';
import { embedConfig } from '../config/index.ts';
import { stashChunkText } from '../embed/handoff.ts';
import { modelIdentity } from '../embed/identity.ts';
import { countLines } from '../scan/frontmatter.ts';
import type { Feature } from './types.ts';

// int8 vectors with a per-vector scale, NULL vector = not yet embedded: reconcile writes dirty
// rows and embedding tops up on the next search, so staleness costs recall.

export type { Chunk };

// The title/summary prefix mirrors bm25 field weighting. Chunks the body, not the raw file, so
// `offset` shifts line numbers back onto raw and a range stays a direct Read range.
function chunksOf(blocks: Block[], body: string, search?: { title: string; summary: string }, offset = 0, chunkTokens?: number): Chunk[] {
  const prefix = [search?.title, search?.summary].filter(Boolean).join('\n');
  // A hardcoded option change here must bump src/chunk/version.ts's CHUNK_VERSION, the signature
  // for every chunker input not already carried in config.
  return chunkFromBlocks(blocks, body, chunkTokens !== undefined ? { targetTokens: chunkTokens } : undefined).map((c) => ({
    startLine: c.startLine + offset,
    endLine: c.endLine + offset,
    text: prefix ? `${prefix}\n${c.text}` : c.text,
  }));
}

export const embed: Feature = {
  name: 'embed',
  async schema(db) {
    await db.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  },
  extract(raw, body, search, _data, cfg, blocks) {
    // Lines the frontmatter occupies, so body line 1 maps back to its raw line number.
    // blocks comes from parseFile's shared parse; falls back to parsing body for a direct call.
    return chunksOf(blocks ?? parse(body), body, search, countLines(raw) - countLines(body), cfg?.embed?.chunkTokens);
  },
  async remove(db, paths) {
    if (paths.length === 0) return;
    await db.runBatch(
      'DELETE FROM embeddings WHERE "path" = ?',
      paths.map((p) => [p])
    );
  },
  // A tree with no embedding model never had extract() run for the doc (reconcile.ts's per-file
  // filter skips it), so extracted is undefined here -- those docs contribute no rows.
  async store(db, docs) {
    const rows: unknown[][] = [];
    const texts = new Map<string, string[]>();
    for (const { path, extracted } of docs) {
      if (!extracted) continue;
      const chunks = extracted as Chunk[];
      chunks.forEach((c, idx) => rows.push([path, idx, c.startLine, c.endLine]));
      texts.set(
        path,
        chunks.map((c) => c.text)
      );
    }
    if (rows.length === 0) return;
    await db.runBatch('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)', rows);
    // The text extract() just computed, handed to the embed pass that follows in this same
    // process rather than re-derived from the file there (src/embed/handoff.ts).
    stashChunkText(db, texts);
  },
  enabledForFile(_cfg, file) {
    return file.embed;
  },
  // Keyed so a rebuild notice can name it "embed settings". Driven by embedConfig(cfg) directly:
  // a model can be configured with no preset yet using vectors.
  signature(cfg) {
    const e = embedConfig(cfg);
    if (!e) return 'embed:off';
    // Weight identity from identity.ts, no network: a static model's resolved sha or local
    // size+mtime, appended once known so changed weights re-embed.
    const identity = e.provider === 'static' ? modelIdentity(e.model) : undefined;
    // W3b: chunkTokens rides the version token, since it's the one owner lever the chunker
    // itself takes -- changing or clearing it must rebuild exactly like a chunker version bump.
    const chunkVersion = e.chunkTokens !== undefined ? `${CHUNK_VERSION}:${e.chunkTokens}` : CHUNK_VERSION;
    return `embed:${e.provider}:${e.model}:${chunkVersion}${identity !== undefined ? `@${identity}` : ''}`;
  },
};
