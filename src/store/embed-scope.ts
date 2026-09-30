// Decomposition of the `embed:` featureSignature segment (config/access.ts's featureSignature,
// features/embed.ts's signature()), for open()'s narrow embed-invalidation routing.

export type EmbedChangeKind = 'model' | 'chunk';

interface EmbedSegment {
  provider: string;
  model: string;
  endpoint?: string;
  chunkVersion: string;
}

// One embed segment's provider/model/endpoint/chunkVersion, ignoring any trailing `@identity`.
// The endpoint-less HTTP shape remains readable so upgrading invalidates vectors, not core data.
function parseEmbedSegment(sig: string): EmbedSegment | null {
  const part = sig.split('|').find((p) => p.startsWith('embed:'));
  if (part === undefined || part === 'embed:off') return null;
  const at = part.indexOf('@');
  const body = at === -1 ? part : part.slice(0, at);
  const withEndpoint = /^embed:(openai|cohere):(.+):endpoint=([0-9a-f]{64}):(chunk:v\d+(?::\d+)?)$/.exec(body);
  if (withEndpoint) {
    const [, provider, model, endpoint, chunkVersion] = withEndpoint;
    return { provider, model, endpoint, chunkVersion };
  }
  const legacy = /^embed:(static|openai|cohere):(.+):(chunk:v\d+(?::\d+)?)$/.exec(body);
  if (!legacy) return null;
  const [, provider, model, chunkVersion] = legacy;
  return { provider, model, chunkVersion };
}

// 'chunk' when chunkTokens or the chunk version moved (boundaries changed, embeddings rebuild);
// 'model' when only the provider or model moved (rows unchanged, values stale); null otherwise.
export function classifyEmbedChange(before: string, after: string): EmbedChangeKind | null {
  const b = parseEmbedSegment(before);
  const a = parseEmbedSegment(after);
  if (b === null || a === null) return null;
  if (b.chunkVersion !== a.chunkVersion) return 'chunk';
  if (b.provider !== a.provider || b.model !== a.model || b.endpoint !== a.endpoint) return 'model';
  return null;
}
