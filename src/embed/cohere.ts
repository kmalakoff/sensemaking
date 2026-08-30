import { SenseError } from '../errors.ts';
import { fetchWithRetry } from './http.ts';
import type { EmbedProvider } from './types.ts';

const BATCH_CAP = 96;

// Cohere's native /v2/embed: input_type distinguishes doc vs query embeddings, which the
// OpenAI-compatible shape cannot express.
export async function cohereProvider(model: string, url: string | undefined, keyEnv: string | undefined): Promise<EmbedProvider> {
  const base = (url ?? 'https://api.cohere.com').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  async function post(texts: string[], inputType: 'search_document' | 'search_query'): Promise<Float32Array[]> {
    const res = await fetchWithRetry(`${base}/v2/embed`, { method: 'POST', headers, body: JSON.stringify({ model, input_type: inputType, texts, embedding_types: ['float'] }) });
    if (!res.ok) throw new SenseError('EMBED_MODEL', `${base}/v2/embed -> HTTP ${res.status}`);
    const body = (await res.json()) as { embeddings: { float: number[][] } };
    // Cohere returns one vector per text in order, with no index field to re-sort by; a caller
    // maps them positionally, so the count below must be trustworthy.
    const vectors = body.embeddings.float;
    if (vectors.length !== texts.length) throw new SenseError('EMBED_MODEL', `${base}/v2/embed returned ${vectors.length} embeddings for ${texts.length} inputs`);
    return vectors.map((v) => Float32Array.from(v));
  }

  const dims = (await post(['dimension probe'], 'search_query'))[0].length;
  return { id: `cohere:${base}:${model}`, dims, batchCap: BATCH_CAP, embedDocuments: (texts) => post(texts, 'search_document'), embedQuery: async (text) => (await post([text], 'search_query'))[0] };
}
