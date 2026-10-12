import { type EnginePatch, selectBuilders } from '../engine.ts';
import { tursoNative } from './native.ts';

// Every statement this store sends to Turso's native FTS; a version that behaves differently gets a TURSO_PATCHES entry.
export interface TursoFtsBuilders {
  // The two FTS indexes. The ngram index is scoped to disjoint "_ngram" sidecar columns: a second index over the same
  // columns makes a bare substring match a whole word, defeating the prefix-query rejection.
  indexDdl(): readonly string[];
  // `literal` is already escaped: the query argument must be a SQL literal, since bound as `?` the row set stays correct
  // but fts_score silently returns 0. fts_score is real only as a SELECT's bare projected expression for the index
  // that SELECT's fts_match chose; every other form silently returns 0.
  score(columns: string, literal: string): string;
  match(columns: string, literal: string): string;
}

export const TURSO_FTS_BUILDERS: TursoFtsBuilders = {
  indexDdl: () => [
    `CREATE INDEX IF NOT EXISTS content_fts ON content USING fts (title_stem, summary_stem, text_stem) WITH (weights = 'title_stem=10.0,summary_stem=5.0,text_stem=1.0')`,
    `CREATE INDEX IF NOT EXISTS content_fts_ngram ON content USING fts (title_ngram, summary_ngram, text_ngram) WITH (tokenizer='ngram', weights='title_ngram=10.0,summary_ngram=5.0,text_ngram=1.0')`,
  ],
  score: (columns, literal) => `fts_score(${columns}, '${literal}')`,
  match: (columns, literal) => `fts_match(${columns}, '${literal}')`,
};

export const TURSO_PATCHES: readonly EnginePatch<TursoFtsBuilders>[] = [];

export async function tursoFts(): Promise<TursoFtsBuilders> {
  return selectBuilders(TURSO_FTS_BUILDERS, TURSO_PATCHES, (await tursoNative()).version);
}
