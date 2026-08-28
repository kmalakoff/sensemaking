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
