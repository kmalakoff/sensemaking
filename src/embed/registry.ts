import type { Config } from '../config/index.ts';
import { embedConfig } from '../config/index.ts';
import { SenseError } from '../errors.ts';
import { cohereProvider } from './cohere.ts';
import { openaiProvider } from './openai.ts';
import { staticProvider } from './static.ts';
import type { EmbedProvider } from './types.ts';

type ProviderFactory = (model: string, url: string | undefined, key: string | undefined) => Promise<EmbedProvider>;

// One factory per wire protocol: adding a protocol is a new file plus an entry here, not
// an edit to a dispatch ternary.
const REGISTRY: Record<string, ProviderFactory> = {
  static: (model) => staticProvider(model),
  openai: (model, url, key) => openaiProvider(model, url, key),
  cohere: (model, url, key) => cohereProvider(model, url, key),
};

const providers = new Map<string, Promise<EmbedProvider>>();

export function getProvider(cfg: Config): Promise<EmbedProvider> {
  const e = embedConfig(cfg);
  if (!e) throw new SenseError('EMBED_DISABLED', 'this tree has no embedding model: add an "embed" block naming one to sense.config.json; a Hugging Face id fetches automatically at first use, or run `sense download` to prefetch it');
  const factory = REGISTRY[e.provider];
  if (!factory) throw new SenseError('EMBED_MODEL', `embed.provider "${e.provider}" has no provider implementation in this build`);
  // Every input that shapes the provider is in the key: two trees sharing an endpoint and
  // model but declaring different languages or reading different key env vars are two
  // providers, not one, however long a process lives.
  const sig = JSON.stringify([e.provider, e.model, e.url ?? '', e.key ?? '', e.languages ?? []]);
  let p = providers.get(sig);
  if (!p) {
    p = factory(e.model, e.url, e.key);
    // Owner-declared languages override a provider's own: the config is the one home for
    // what no model card can state (http models have no fetchable card here).
    if (e.languages) p = p.then((prov) => ({ ...prov, languages: e.languages }));
    providers.set(sig, p);
    // A rejected construction is evicted, so a transient failure retries instead of
    // poisoning this config for the process lifetime.
    p.catch(() => providers.delete(sig));
  }
  return p;
}
