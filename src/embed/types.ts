// Storage lever fixed by the bake-off (benchmark/reports/2026-08-13-static-model-bakeoff.md):
// int8 at 256 dims is quality-free vs f32-512 when fused; also the duckdb store's FLOAT[N] width.
export const STORE_DIMS = 256;

// The provider contract every wire protocol implements: a Liskov-substitutable
// surface so query/search code never branches on provider identity.
export interface EmbedProvider {
  id: string; // model identity; participates in the cache key, change -> re-embed
  dims: number;
  batchCap: number; // max texts per embedDocuments call
  languages?: string[]; // declared model languages, for the language-fit check
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}
