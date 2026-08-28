import { fenceTracker } from '../fences.ts';
import type { Feature } from './types.ts';

// Heading-based chunks, int8 vectors with a per-vector scale, NULL vector = not yet embedded.
// Reconcile writes dirty rows; embedding tops up on the next search, so staleness costs recall.
// Providers, the vector fill, and the search-time helpers live under src/embed/.

export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

// Deterministic, so embed time can re-derive text from stored line ranges. Heading-delimited,
// preamble kept, whole body when no headings; the title/summary prefix mirrors bm25 weighting.
//
// Chunks the body, not the raw file, with `offset` shifting line numbers back onto the raw
// file so a range stays a direct Read range (sections is 1-indexed over raw too). Chunking raw
// put the frontmatter block in its own leading chunk on every note with a heading, which made
// `lines` point at YAML and made frontmatter-only notes near-identical to each other. It also
// disagreed with FTS, which indexes the body alone.
function chunksOf(body: string, search?: { title: string; summary: string }, offset = 0): Chunk[] {
  const lines = body.split('\n');
  const starts: number[] = [];
  const fence = fenceTracker();
  for (let i = 0; i < lines.length; i++) {
    if (fence.feed(lines[i])) continue;
    if (!fence.inFence && /^#{1,6} +/.test(lines[i])) starts.push(i + 1);
  }
  const bounds = starts.length === 0 ? [1] : starts[0] > 1 ? [1, ...starts] : starts;
  const prefix = [search?.title, search?.summary].filter(Boolean).join('\n');
  const chunks: Chunk[] = [];
  bounds.forEach((start, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1] - 1 : lines.length;
    const text = lines
      .slice(start - 1, end)
      .join('\n')
      .trim();
    // A body with nothing in it yields no chunks at all, so a frontmatter-only note has no
    // vectors rather than a vector of its own YAML.
    if (text.length > 0) chunks.push({ startLine: start + offset, endLine: end + offset, text: prefix ? `${prefix}\n${text}` : text });
  });
  return chunks;
}

export const embed: Feature = {
  name: 'embed',
  schema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS embeddings ("path" TEXT, chunk INTEGER, start_line INTEGER, end_line INTEGER, scale REAL, vector BLOB, PRIMARY KEY ("path", chunk))`);
  },
  extract(raw, body, search) {
    // Lines the frontmatter occupies, so body line 1 maps back to its raw line number.
    return chunksOf(body, search, raw.split('\n').length - body.split('\n').length);
  },
  remove(db, path) {
    db.prepare('DELETE FROM embeddings WHERE "path" = ?').run(path);
  },
  // A tree with no embedding model never had extract() run for the doc (db.ts's per-file
  // filter skips it), so extracted is undefined here -- store nothing, i.e. no rows.
  store(db, path, extracted) {
    if (!extracted) return;
    const insert = db.prepare('INSERT INTO embeddings ("path", chunk, start_line, end_line, scale, vector) VALUES (?, ?, ?, ?, NULL, NULL)');
    (extracted as Chunk[]).forEach((c, idx) => insert.run(path, idx, c.startLine, c.endLine));
  },
  enabledForFile(_cfg, file) {
    return file.embed;
  },
};
