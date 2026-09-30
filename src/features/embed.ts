import type { Block, Chunk } from '../chunk/index.ts';
import { CHUNK_VERSION, chunkFromBlocks, parse } from '../chunk/index.ts';
import { embedConfig } from '../config/index.ts';
import { embedEndpointIdentity } from '../embed/endpoint.ts';
import { identifyChunkText, stashChunkText } from '../embed/handoff.ts';
import { modelIdentity } from '../embed/identity.ts';
import { countLines } from '../scan/frontmatter.ts';
import { appendRows } from '../store/shared.ts';
import type { Feature } from './types.ts';

// int8 vectors with a per-vector scale, NULL vector = not yet embedded: reconcile writes dirty
// rows and build (or an authorised scoped CLI query) prepares them before semantic retrieval.

export type { Chunk };

const CHUNK_LOOKUP_PAGE = 512;
interface ChunkRow {
  chunk: number;
  start_line: number;
  end_line: number;
  content_identity: string;
}

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
    await db.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, content_identity TEXT NOT NULL, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  },
  extract(raw, body, search, _data, cfg, blocks) {
    // Lines the frontmatter occupies, so body line 1 maps back to its raw line number.
    // blocks comes from parseFile's shared parse; falls back to parsing body for a direct call.
    return chunksOf(blocks ?? parse(body), body, search, countLines(raw) - countLines(body), cfg?.embed?.chunkTokens);
  },
  async remove(db, paths, delta) {
    const vanishedSet = new Set(delta.vanished);
    const vanished = paths.filter((path) => vanishedSet.has(path));
    if (vanished.length === 0) return;
    await db.runBatch(
      'DELETE FROM embeddings WHERE "path" = ?',
      vanished.map((path) => [path])
    );
  },
  // A tree with no embedding model never had extract() run for the doc (reconcile.ts's per-file
  // filter skips it), so extracted is undefined here -- those docs contribute no rows.
  async store(db, docs, delta) {
    const rows: unknown[][] = [];
    const texts = new Map<string, ReturnType<typeof identifyChunkText>[]>();
    const added = new Set(delta.added);
    // Keyset pages bound comparison metadata without reading native vector payloads.
    let firstPage: Awaited<ReturnType<typeof db.prepare>> | undefined;
    let nextPage: Awaited<ReturnType<typeof db.prepare>> | undefined;
    for (const { path, extracted } of docs) {
      const chunks = (extracted as Chunk[] | undefined) ?? [];
      if (chunks.length === 0) {
        if (!added.has(path)) await db.runBatch('DELETE FROM embeddings WHERE "path" = ?', [[path]]);
        continue;
      }
      const identified = chunks.map((chunk) => identifyChunkText(chunk.text));
      const kept = new Set<number>();
      if (!added.has(path)) {
        let cursor: number | undefined;
        for (;;) {
          let page: ChunkRow[];
          if (cursor === undefined) {
            firstPage ??= await db.prepare(`SELECT chunk, start_line, end_line, content_identity FROM embeddings WHERE "path" = ? ORDER BY chunk LIMIT ${CHUNK_LOOKUP_PAGE}`);
            page = (await firstPage.all(path)) as ChunkRow[];
          } else {
            nextPage ??= await db.prepare(`SELECT chunk, start_line, end_line, content_identity FROM embeddings WHERE "path" = ? AND chunk > ? ORDER BY chunk LIMIT ${CHUNK_LOOKUP_PAGE}`);
            page = (await nextPage.all(path, cursor)) as ChunkRow[];
          }
          const removed: unknown[][] = [];
          const moved: unknown[][] = [];
          for (const old of page) {
            const index = Number(old.chunk);
            const chunk = chunks[index];
            if (!chunk || old.content_identity !== identified[index].identity) {
              removed.push([path, index]);
            } else {
              kept.add(index);
              if (Number(old.start_line) !== chunk.startLine || Number(old.end_line) !== chunk.endLine) moved.push([chunk.startLine, chunk.endLine, path, index]);
            }
          }
          if (removed.length > 0) await db.runBatch('DELETE FROM embeddings WHERE "path" = ? AND chunk = ?', removed);
          if (moved.length > 0) await db.runBatch('UPDATE embeddings SET start_line = ?, end_line = ? WHERE "path" = ? AND chunk = ?', moved);
          if (page.length < CHUNK_LOOKUP_PAGE) break;
          cursor = Number(page[page.length - 1].chunk);
        }
      }
      const before = rows.length;
      chunks.forEach((chunk, index) => {
        if (!kept.has(index)) rows.push([path, index, chunk.startLine, chunk.endLine, identified[index].identity]);
      });
      // No new pending rows means no retained handoff. Matching pending rows can use
      // embedPending's exact indexed-source fallback, including after repeated store calls.
      if (rows.length > before) texts.set(path, identified);
    }
    // scale and vector are written by the embed pass, not here, so they are not in the column list
    // and take the table's own default on the append path.
    await appendRows(db, 'embeddings', ['path', 'chunk', 'start_line', 'end_line', 'content_identity'], 'INSERT INTO embeddings ("path", chunk, start_line, end_line, content_identity, scale, vector) VALUES (?, ?, ?, ?, ?, NULL, NULL)', rows);
    // Hand off only paths with new pending rows; missing entries use the indexed source.
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
    const endpoint = embedEndpointIdentity(e.provider, e.url);
    const endpointPart = endpoint === undefined ? '' : `:endpoint=${endpoint}`;
    return `embed:${e.provider}:${e.model}${endpointPart}:${chunkVersion}${identity !== undefined ? `@${identity}` : ''}`;
  },
};
