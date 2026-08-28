import { SenseError } from '../errors.ts';
import { presetNames, presetSignals } from './access.ts';
import type { Config, EffectiveSearch, Preset, SearchOverrides } from './types.ts';

// Looks up a declared preset by name, defaulting to `default`. Throws naming every declared
// preset when an explicit name is not declared -- the `default` fallback is never unknown
// itself (validateConfig requires it).
export function resolvePreset(cfg: Config, name?: string): { name: string; preset: Preset } {
  const presetName = name ?? 'default';
  const preset = cfg.presets[presetName];
  if (!preset) throw new SenseError('PRESET_UNKNOWN', `unknown preset "${presetName}"; declared presets: ${presetNames(cfg).join(', ')}`);
  return { name: presetName, preset };
}

// Precedence, per field: built-ins <- named preset (or `default`) <- caller overrides.
// `opts` arrives with any saved-query/CLI merge already resolved (src/cli/named.ts).
export function resolveSearch(cfg: Config, opts: SearchOverrides = {}): EffectiveSearch {
  const { name: presetName, preset } = resolvePreset(cfg, opts.preset);
  const k = opts.k ?? preset.k ?? 10;
  const where = opts.where ?? preset.where;
  // Each overrides its own side only, so neither clears the other.
  const include = opts.include ?? preset.include;
  // --no-exclude widens past the preset's exclusions; an explicit --exclude alongside it is
  // still the scope for this command, since it says what to leave out rather than what to keep.
  const exclude = opts.exclude ?? (opts.noExclude ? undefined : preset.exclude);
  return { presetName, k, where, include, exclude, signals: presetSignals(cfg, presetName) };
}
