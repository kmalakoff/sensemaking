import { SenseError } from '../errors.ts';
import { effectiveEmbedEndpoint } from './endpoint.ts';
import { fetchWithRetry, HTTP_ATTEMPT_TIMEOUT_MS } from './http.ts';
import type { EmbedCallOptions, EmbedProvider } from './types.ts';

const BATCH_CAP = 96;

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'number');
}

function isEmbeddingArray(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(isNumberArray);
}

function parseBody(body: ArrayBuffer, endpoint: string): number[][] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SenseError('EMBED_MODEL', `${endpoint} returned invalid JSON`);
  }
  if (decoded === null || typeof decoded !== 'object' || !('embeddings' in decoded) || decoded.embeddings === null || typeof decoded.embeddings !== 'object' || !('float' in decoded.embeddings) || !isEmbeddingArray(decoded.embeddings.float)) {
    throw new SenseError('EMBED_MODEL', `${endpoint} returned an invalid embedding response`);
  }
  return decoded.embeddings.float;
}

// Cohere's native /v2/embed: input_type distinguishes doc vs query embeddings, which the
// OpenAI-compatible shape cannot express.
export async function cohereProvider(model: string, url: string | undefined, keyEnv: string | undefined): Promise<EmbedProvider> {
  const base = effectiveEmbedEndpoint('cohere', url);
  if (!base) throw new SenseError('EMBED_MODEL', 'cohere endpoint resolution failed');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  async function post(texts: string[], inputType: 'search_document' | 'search_query', options?: EmbedCallOptions): Promise<Float32Array[]> {
    const res = await fetchWithRetry(`${base}/v2/embed`, { method: 'POST', headers, body: JSON.stringify({ model, input_type: inputType, texts, embedding_types: ['float'] }) }, { signal: options?.signal, attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS });
    options?.signal?.throwIfAborted();
    if (!res.ok) throw new SenseError('EMBED_MODEL', `${res.url} -> HTTP ${res.status}`);
    const body = parseBody(res.body, res.url);
    // Cohere returns one vector per text in order, with no index field to re-sort by; a caller
    // maps them positionally, so the count below must be trustworthy.
    const vectors = body;
    if (vectors.length !== texts.length) throw new SenseError('EMBED_MODEL', `${res.url} returned ${vectors.length} embeddings for ${texts.length} inputs`);
    return vectors.map((v) => Float32Array.from(v));
  }

  const dims = (await post(['dimension probe'], 'search_query'))[0].length;
  return { id: `cohere:${base}:${model}`, dims, batchCap: BATCH_CAP, embedDocuments: (texts, options) => post(texts, 'search_document', options), embedQuery: async (text, options) => (await post([text], 'search_query', options))[0] };
}
