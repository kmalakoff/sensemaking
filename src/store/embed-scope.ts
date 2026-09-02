// Decomposition of the `embed:` featureSignature segment (config/access.ts's featureSignature,
// features/embed.ts's signature()), for open()'s narrow embed-invalidation routing.

export type EmbedChangeKind = 'model' | 'chunk';

interface EmbedSegment {
  provider: string;
  model: string;
  chunkVersion: string;
}

// One embed segment's provider/model/chunkVersion, ignoring any trailing `@identity`. `embed:off`
// and any segment not in that exact shape return null, so the caller falls back to a full rebuild.
function parseEmbedSegment(sig: string): EmbedSegment | null {
  const part = sig.split('|').find((p) => p.startsWith('embed:'));
  if (part === undefined || part === 'embed:off') return null;
  const at = part.indexOf('@');
  const body = at === -1 ? part : part.slice(0, at);
  const match = /^embed:(static|openai|cohere):(.+):(chunk:v\d+(?::\d+)?)$/.exec(body);
  if (!match) return null;
  const [, provider, model, chunkVersion] = match;
  return { provider, model, chunkVersion };
}

// 'chunk' when chunkTokens or the chunk version moved (boundaries changed, embeddings rebuild);
// 'model' when only the provider or model moved (rows unchanged, values stale); null otherwise.
export function classifyEmbedChange(before: string, after: string): EmbedChangeKind | null {
  const b = parseEmbedSegment(before);
  const a = parseEmbedSegment(after);
  if (b === null || a === null) return null;
  if (b.chunkVersion !== a.chunkVersion) return 'chunk';
  if (b.provider !== a.provider || b.model !== a.model) return 'model';
  return null;
}
