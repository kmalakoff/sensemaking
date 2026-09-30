import { createHash } from 'node:crypto';

const DEFAULT_COHERE_ENDPOINT = 'https://api.cohere.com';

export function effectiveEmbedEndpoint(provider: 'static' | 'openai' | 'cohere', url: string | undefined): string | undefined {
  if (provider === 'static') return undefined;
  const endpoint = provider === 'cohere' ? (url ?? DEFAULT_COHERE_ENDPOINT) : url;
  return endpoint?.replace(/\/+$/, '');
}

export function embedEndpointIdentity(provider: 'static' | 'openai' | 'cohere', url: string | undefined): string | undefined {
  const endpoint = effectiveEmbedEndpoint(provider, url);
  return endpoint === undefined ? undefined : createHash('sha256').update(endpoint).digest('hex');
}
