import type { Config } from '../config/index.ts';
import { presetHasSignal } from '../config/index.ts';
import { listFiles } from '../scan/index.ts';

// A signature change open() can route to a narrow reparse instead of a full clear: every changed
// segment is a preset's own (glob or vector on/off), never a global feature or embed change.
export function isPresetOnlyChange(changedKeys: ReadonlySet<string>): boolean {
  return changedKeys.size > 0 && [...changedKeys].every((key) => key.startsWith('preset:'));
}

interface PresetDef {
  include: string[];
  exclude: string[];
  vectors: boolean;
}

// One preset's old include/exclude/vectors-on-off, read back out of a stored `preset:<name>:...`
// segment (config/access.ts's featureSignature format). Absent (a brand-new preset) is the empty
// preset, not a parse failure; a segment present but not in that exact shape returns null so the
// caller falls back to a full rebuild instead of guessing.
function parseOldPreset(before: string, name: string): PresetDef | null {
  const part = before.split('|').find((p) => p.startsWith(`preset:${name}:`));
  if (part === undefined) return { include: [], exclude: [], vectors: false };
  const fields = part.split(':');
  if (fields.length !== 5) return null;
  const [, , includeStr, excludeStr, onOff] = fields;
  if (onOff !== 'on' && onOff !== 'off') return null;
  return { include: includeStr === '' ? [] : includeStr.split('+'), exclude: excludeStr === '' ? [] : excludeStr.split('+'), vectors: onOff === 'on' };
}

// Paths one preset definition covers, via the real listFiles so stat filtering (directories,
// dangling symlinks) matches production coverage exactly.
function matchPreset(cfg: Config, baseDir: string, name: string, def: PresetDef): Set<string> {
  const scoped: Config = { ...cfg, presets: { [name]: { include: def.include, exclude: def.exclude } } };
  return new Set(listFiles(scoped, baseDir).map((f) => f.relPath));
}

// Every path whose coverage by a changed preset genuinely moved: gained or lost it (a glob edit),
// or kept it under a flipped vectors on/off (that preset's whole match set, since its contribution
// to the file's union embed flag may have changed even though membership itself did not). Returns
// null when a changed preset's stored segment can't be parsed, so the caller takes the full rebuild.
export function forcedPresetPaths(cfg: Config, baseDir: string, before: string, changedKeys: ReadonlySet<string>): Set<string> | null {
  const forced = new Set<string>();
  for (const key of changedKeys) {
    const name = key.slice('preset:'.length);
    const oldDef = parseOldPreset(before, name);
    if (oldDef === null) return null;
    const stillDeclared = Object.hasOwn(cfg.presets, name);
    const newDef: PresetDef = stillDeclared ? { include: cfg.presets[name].include, exclude: cfg.presets[name].exclude ?? [], vectors: presetHasSignal(cfg, name, 'vectors') } : { include: [], exclude: [], vectors: false };

    const oldMatch = matchPreset(cfg, baseDir, name, oldDef);
    const newMatch = stillDeclared ? matchPreset(cfg, baseDir, name, newDef) : new Set<string>();

    if (oldDef.vectors !== newDef.vectors) {
      for (const p of oldMatch) forced.add(p);
      for (const p of newMatch) forced.add(p);
    } else {
      for (const p of oldMatch) if (!newMatch.has(p)) forced.add(p);
      for (const p of newMatch) if (!oldMatch.has(p)) forced.add(p);
    }
  }
  return forced;
}
