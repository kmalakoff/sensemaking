import type { Connection } from './types.ts';

// Seed chunks that participate in a `related` scan. Cost is target_chunks x stored_chunks, so a
// heading-dense seed multiplies a full-corpus scan (12.7s at 201 chunks/note unsampled).
export const TARGET_CHUNK_CAP = 16;

// Evenly samples down to at most `cap` rows, so late sections of a long note still get a vote
// instead of being cut off by a fixed prefix.
export function sampleEvenly<T>(rows: T[], cap: number = TARGET_CHUNK_CAP): T[] {
  const step = Math.max(1, Math.ceil(rows.length / cap));
  return rows.filter((_, i) => i % step === 0);
}

// Dequantised int8 dot products (sqlite) land a little either side of a true cosine, so an
// identical pair can print 1.001; array_cosine_similarity (duckdb) has no such error but is
// rounded the same way, so both stores print the same bounded number.
export function asCosine(score: number): number {
  return Math.round(Math.min(1, Math.max(-1, score)) * 1000) / 1000;
}

export async function pendingRows(conn: Connection): Promise<Array<{ path: string; chunk: number }>> {
  const stmt = await conn.prepare('SELECT "path", chunk FROM embeddings WHERE vector IS NULL ORDER BY "path", chunk');
  return (await stmt.all()) as Array<{ path: string; chunk: number }>;
}

// Whether a note has any chunk with a vector. Distinguishes "nothing is near this note" from
// "this note has no text", which look the same in an empty result.
export async function hasVectorRow(conn: Connection, path: string): Promise<boolean> {
  const stmt = await conn.prepare('SELECT 1 AS ok FROM embeddings WHERE "path" = ? AND vector IS NOT NULL LIMIT 1');
  const row = (await stmt.get(path)) as { ok: number } | undefined;
  return row !== undefined;
}
