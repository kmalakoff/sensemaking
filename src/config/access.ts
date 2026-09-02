import type { Feature } from '../features/types.ts';
import type { SignalName, SignalWeights } from './signals.ts';
import { type Config, type EmbedConfig, FEATURE_NAMES, type FeatureName, type StoreName } from './types.ts';

export function presetNames(cfg: Config): string[] {
  return Object.keys(cfg.presets);
}

// The backing store engine this tree uses; absent means the default.
export function storeName(cfg: Config): StoreName {
  return cfg.store ?? 'sqlite';
}

// Whether the tree names a model at all.
export function embedEnabled(cfg: Config): boolean {
  return typeof cfg.embed?.model === 'string' && cfg.embed.model.length > 0;
}

// A preset's effective signal weights: declared exhaustively when `signals` is present, else
// every signal whose prerequisite holds at weight 1 (words always, links when on, vectors when a model is named).
export function presetSignals(cfg: Config, name: string): SignalWeights {
  const declared = cfg.presets[name]?.signals;
  if (declared) return declared;
  const signals: SignalWeights = { words: 1 };
  if (cfg.features?.links !== false) signals.links = 1;
  if (embedEnabled(cfg)) signals.vectors = 1;
  return signals;
}

export function presetHasSignal(cfg: Config, name: string, signal: SignalName): boolean {
  return presetSignals(cfg, name)[signal] !== undefined;
}

// Whether embedding needs to run: a model is named AND some preset's effective signals include vectors.
export function anyPresetEmbeds(cfg: Config): boolean {
  return presetNames(cfg).some((name) => presetHasSignal(cfg, name, 'vectors'));
}

// Opt-out features (default on): absent block or key means enabled. `rank` additionally requires
// `links`. `embed` is derived (not a features-block member): on iff some preset's signals include vectors.
export function featureEnabled(cfg: Config, name: FeatureName): boolean {
  if (name === 'embed') return anyPresetEmbeds(cfg);
  const enabled = cfg.features?.[name] !== false;
  if (name === 'rank') return enabled && featureEnabled(cfg, 'links');
  return enabled;
}

export function enabledFeatures(cfg: Config): FeatureName[] {
  return FEATURE_NAMES.filter((name) => featureEnabled(cfg, name));
}

// Feature states, so "off" and "empty" stay distinguishable in output. `embed` is excluded:
// it is not a features-block toggle, and `status` reports it on its own line.
export function featureStates(cfg: Config): { on: FeatureName[]; off: FeatureName[] } {
  const reported = FEATURE_NAMES.filter((name) => name !== 'embed');
  return {
    on: reported.filter((name) => featureEnabled(cfg, name)),
    off: reported.filter((name) => !featureEnabled(cfg, name)),
  };
}

// Resolved embed provider settings, or null when the config names no model. No fallback to
// DEFAULT_EMBED_MODEL: that's a template constant `init` and the v4 migration write into the file, never a runtime default.
export function embedConfig(cfg: Config): { model: string; provider: 'static' | 'openai' | 'cohere'; url?: string; key?: string; languages?: string[]; chunkTokens?: number } | null {
  if (!embedEnabled(cfg)) return null;
  const e = cfg.embed as EmbedConfig;
  return { model: e.model as string, provider: e.provider ?? 'static', url: e.url, key: e.key, languages: e.languages, chunkTokens: e.chunkTokens };
}

// Cache key over everything indexing derives from, so any change to those inputs rebuilds.
// Segment order is fixed (one `feature:<name>:on|off` per FEATURE_NAMES entry but embed, then
// `features` in registry order, then presets) since reordering alone would fire a spurious
// rebuild; presets stay here because no Feature module owns it.
export function featureSignature(cfg: Config, features: Feature[]): string {
  // One segment per toggle (not one lumped csv) so store/signature.ts's changedSignatureKeys can
  // tell which feature moved -- store/feature-scope.ts routes a recognised toggle to a narrow
  // per-table invalidation instead of the full clear.
  const togglesPart = FEATURE_NAMES.filter((name) => name !== 'embed').map((name) => `feature:${name}:${featureEnabled(cfg, name) ? 'on' : 'off'}`);
  const featureParts = features.map((feature) => feature.signature?.(cfg)).filter((part): part is string => part !== undefined);
  // One keyed segment per preset so a rebuild notice can name exactly which preset moved.
  const presetsPart = [...presetNames(cfg)]
    .sort()
    .map((name) => {
      const p = cfg.presets[name];
      const include = [...p.include].sort().join('+');
      const exclude = [...(p.exclude ?? [])].sort().join('+');
      return `preset:${name}:${include}:${exclude}:${presetHasSignal(cfg, name, 'vectors') ? 'on' : 'off'}`;
    })
    .join('|');
  return [...togglesPart, ...featureParts, presetsPart].join('|');
}
