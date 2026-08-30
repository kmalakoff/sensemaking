import { SenseError } from '../errors.ts';
import { fetchWithRetry } from './http.ts';
import type { EmbedProvider } from './types.ts';

const BATCH_CAP = 64;

// One POST against any OpenAI-compatible /embeddings endpoint: Ollama, LM Studio, Cloudflare
// Workers AI, Jina, Voyage, and Gemini's compat base URL all serve this shape.
export async function openaiProvider(model: string, url: string | undefined, keyEnv: string | undefined): Promise<EmbedProvider> {
  if (!url) throw new SenseError('EMBED_MODEL', 'embed.provider "openai" requires a url');
  const base = url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = keyEnv ? process.env[keyEnv] : undefined;
  if (key) headers.authorization = `Bearer ${key}`;

  async function post(texts: string[]): Promise<Float32Array[]> {
    const res = await fetchWithRetry(`${base}/embeddings`, { method: 'POST', headers, body: JSON.stringify({ model, input: texts }) });
    if (!res.ok) throw new SenseError('EMBED_MODEL', `${base}/embeddings -> HTTP ${res.status}`);
    const body = (await res.json()) as { data: Array<{ embedding: number[]; index?: number }> };
    // The schema carries `index` because response order is not promised, and the caller maps
    // vectors back to chunks positionally: sort by it whenever every element has one.
    const data = body.data.every((d) => typeof d.index === 'number') ? [...body.data].sort((a, b) => (a.index as number) - (b.index as number)) : body.data;
    // A server that drops an input (empty or over-length strings are the usual cause) would
    // otherwise shift every later vector onto the wrong chunk, silently.
    if (data.length !== texts.length) throw new SenseError('EMBED_MODEL', `${base}/embeddings returned ${data.length} embeddings for ${texts.length} inputs`);
    return data.map((d) => Float32Array.from(d.embedding));
  }

  const dims = (await post(['dimension probe']))[0].length;
  // embedQuery and embedDocuments are symmetric here; per-model prefixes like nomic's
  // search_document/search_query are not applied.
  return { id: `openai:${base}:${model}`, dims, batchCap: BATCH_CAP, embedDocuments: post, embedQuery: async (text) => (await post([text]))[0] };
}
