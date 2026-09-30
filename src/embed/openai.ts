import { SenseError } from '../errors.ts';
import { effectiveEmbedEndpoint } from './endpoint.ts';
import { fetchWithRetry, HTTP_ATTEMPT_TIMEOUT_MS } from './http.ts';
import type { EmbedCallOptions, EmbedProvider } from './types.ts';

const BATCH_CAP = 64;

interface OpenaiEmbedding {
  embedding: number[];
  index?: number;
}

function isEmbedding(value: unknown): value is OpenaiEmbedding {
  if (value === null || typeof value !== 'object' || !('embedding' in value) || !Array.isArray(value.embedding) || !value.embedding.every((part) => typeof part === 'number')) return false;
  return !('index' in value) || value.index === undefined || typeof value.index === 'number';
}

function parseBody(body: ArrayBuffer, endpoint: string): OpenaiEmbedding[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SenseError('EMBED_MODEL', `${endpoint} returned invalid JSON`);
  }
  if (decoded === null || typeof decoded !== 'object' || !('data' in decoded) || !Array.isArray(decoded.data) || !decoded.data.every(isEmbedding)) {
    throw new SenseError('EMBED_MODEL', `${endpoint} returned an invalid embedding response`);
  }
  return decoded.data;
}

// One POST against any OpenAI-compatible /embeddings endpoint: Ollama, LM Studio, Cloudflare
// Workers AI, Jina, Voyage, and Gemini's compat base URL all serve this shape.
export async function openaiProvider(model: string, url: string | undefined, keyEnv: string | undefined): Promise<EmbedProvider> {
  const base = effectiveEmbedEndpoint('openai', url);
  if (!base) throw new SenseError('EMBED_MODEL', 'embed.provider "openai" requires a url');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  async function post(texts: string[], options?: EmbedCallOptions): Promise<Float32Array[]> {
    const res = await fetchWithRetry(`${base}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model, input: texts }) }, { signal: options?.signal, attemptTimeoutMs: HTTP_ATTEMPT_TIMEOUT_MS });
    options?.signal?.throwIfAborted();
    if (!res.ok) throw new SenseError('EMBED_MODEL', `${res.url} -> HTTP ${res.status}`);
    const body = parseBody(res.body, res.url);
    // The schema carries `index` because response order is not promised, and the caller maps
    // vectors back to chunks positionally: sort by it whenever every element has one.
    const data = body.every((d): d is OpenaiEmbedding & { index: number } => typeof d.index === 'number') ? [...body].sort((a, b) => a.index - b.index) : body;
    // A server that drops an input (empty or over-length strings are the usual cause) would
    // otherwise shift every later vector onto the wrong chunk, silently.
    if (data.length !== texts.length) throw new SenseError('EMBED_MODEL', `${res.url} returned ${data.length} embeddings for ${texts.length} inputs`);
    return data.map((d) => Float32Array.from(d.embedding));
  }

  const dims = (await post(['dimension probe']))[0].length;
  // embedQuery and embedDocuments are symmetric here; per-model prefixes like nomic's
  // search_document/search_query are not applied.
  return { id: `openai:${base}:${model}`, dims, batchCap: BATCH_CAP, embedDocuments: post, embedQuery: async (text, options) => (await post([text], options))[0] };
}
