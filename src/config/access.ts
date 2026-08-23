import { type Config, type EmbedConfig, FEATURE_NAMES, type FeatureName } from './types.ts';

export function presetNames(cfg: Config): string[] {
  return Object.keys(cfg.presets);
}

// Whether the tree names a model at all.
export function embedEnabled(cfg: Config): boolean {
  return typeof cfg.embed?.model === 'string' && cfg.embed.model.length > 0;
}

// A preset's own vector participation: absent or true means on, false means off.
export function presetSemanticEnabled(cfg: Config, name: string): boolean {
  return cfg.presets[name]?.semantic !== false;
}

// Whether embedding needs to run: a model is named AND some preset wants vectors.
export function anyPresetEmbeds(cfg: Config): boolean {
  return embedEnabled(cfg) && presetNames(cfg).some((name) => presetSemanticEnabled(cfg, name));
}

// Opt-out features (default on): absent block or key means enabled. `rank` additionally
// requires `links`. `embed` is derived, not a features-block member: on iff `embed` names a model.
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

// Resolved embed provider settings, or null when the config names no model. There is no
// fallback to DEFAULT_EMBED_MODEL: that constant is a template `init` and the v4 migration
// write into the file, never an implicit runtime default.
export function embedConfig(cfg: Config): { model: string; type: 'static' | 'api'; url?: string; key?: string } | null {
  if (!embedEnabled(cfg)) return null;
  const e = cfg.embed as EmbedConfig;
  return { model: e.model as string, type: e.type ?? 'static', url: e.url, key: e.key };
}

// The configured FTS5 tokenizer, or undefined for the built-in default. Undefined rather than
// the default string so featureSignature can leave the segment off entirely for trees that
// never set it, which is what keeps existing indexes from rebuilding on upgrade.
export function contentTokenize(cfg: Config): string | undefined {
  const tokenize = cfg.content?.tokenize;
  return tokenize === undefined || tokenize.trim() === '' ? undefined : tokenize.trim();
}

// Cache key over everything indexing derives from, so any change to those inputs rebuilds.
export function featureSignature(cfg: Config): string {
  const globalPart = enabledFeatures(cfg)
    .filter((name) => name !== 'embed')
    .join(',');
  const e = embedConfig(cfg);
  const embedPart = e ? `embed:${e.type}:${e.model}` : 'embed:off';
  // One keyed segment per preset so a rebuild notice can name exactly which preset moved.
  const presetsPart = [...presetNames(cfg)]
    .sort()
    .map((name) => {
      const p = cfg.presets[name];
      const include = [...p.include].sort().join('+');
      const exclude = [...(p.exclude ?? [])].sort().join('+');
      return `preset:${name}:${include}:${exclude}:${p.semantic === false ? 'off' : 'on'}`;
    })
    .join('|');
  const tokenize = contentTokenize(cfg);
  const parts = [`features:${globalPart}`, embedPart];
  if (tokenize !== undefined) parts.push(`tokenize:${tokenize}`);
  parts.push(presetsPart);
  return parts.join('|');
}
