import { type EnginePatch, selectBuilders } from '../engine.ts';
import { duckdbNative } from './native.ts';

export const FTS_STEMMER = 'porter';

// Every statement this store sends to the fts extension; a version that behaves differently gets a DUCKDB_PATCHES entry.
// match_bm25 tokenizes its query with the generated fts_main_content.tokenize macro, so queryTerms uses that same macro.
export interface DuckdbFtsBuilders {
  // stopwords='none': sqlite's porter/unicode61 tokenizer never removes stopwords; the extension's default list would
  // drop common words (e.g. "and") from the index but not match_bm25's conjunctive gate, breaking multi-word matches.
  createIndex(): string;
  // One bound parameter, the folded query; returns one original token per stem so native scoring stems once.
  queryTerms(): string;
  // One bound parameter, a single query term, scored within one field.
  termScore(field: string): string;
  // One bound parameter, the space-joined words that must all occur.
  conjunctiveGate(): string;
}

export const DUCKDB_FTS_BUILDERS: DuckdbFtsBuilders = {
  createIndex: () => `PRAGMA create_fts_index('content', 'path', 'title', 'summary', 'text', stemmer='${FTS_STEMMER}', stopwords='none', overwrite=1)`,
  queryTerms: () => `
    WITH tokens AS (SELECT unnest(fts_main_content.tokenize(?)) AS raw_term)
    SELECT min(raw_term) AS term FROM tokens
    WHERE raw_term <> '' GROUP BY stem(raw_term, '${FTS_STEMMER}') ORDER BY term
  `,
  termScore: (field) => `SELECT fts_main_content.match_bm25(content."path", ?, fields := '${field}', conjunctive := false) AS score`,
  conjunctiveGate: () => `fts_main_content.match_bm25(content."path", ?, conjunctive := true) IS NOT NULL`,
};

// Empty: DuckDB 1.4.5, 1.5.0 and 1.5.6 produce identical macros, tokens and scores (probed 2026-10-11).
export const DUCKDB_PATCHES: readonly EnginePatch<DuckdbFtsBuilders>[] = [];

export async function duckdbFts(): Promise<DuckdbFtsBuilders> {
  return selectBuilders(DUCKDB_FTS_BUILDERS, DUCKDB_PATCHES, (await duckdbNative()).version);
}
