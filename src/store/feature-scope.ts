import type { FeatureName } from '../config/index.ts';

// Decomposition of the `feature:<name>:<on|off>` featureSignature segments (config/access.ts's
// featureSignature), for open()'s narrow feature-toggle invalidation routing.

// Every narrow-supported feature but rank owns one dedicated table, dropped and (turning on)
// fully re-derived. rank has no table -- it writes PageRank into frontmatter's own `_rank`
// column -- so builder.ts handles it, and the links/rank pair, as special cases outside this map.
export const NARROW_FEATURE_TABLE: Readonly<Record<string, string>> = { tags: 'tags', sections: 'sections', links: 'links' };

// links feeds rank's afterReconcile pass, so a links toggle always co-changes the `feature:rank`
// segment too (featureEnabled's dependency); both are narrow-supported and builder.ts applies
// them together. A changed set naming any other feature falls through to the existing full clear.
const NARROW_FEATURE_NAMES: ReadonlySet<string> = new Set([...Object.keys(NARROW_FEATURE_TABLE), 'rank']);

export interface FeatureToggle {
  name: FeatureName;
  // true: was off, now on (must fully re-derive). false: was on, now off (drop its rows).
  turnedOn: boolean;
}

// Every changed key is a `feature:<name>` segment for a narrow-supported feature.
export function isFeatureOnlyChange(changedKeys: ReadonlySet<string>): boolean {
  return changedKeys.size > 0 && [...changedKeys].every((key) => key.startsWith('feature:') && NARROW_FEATURE_NAMES.has(key.slice('feature:'.length)));
}

// One feature segment's old on/off, read back out of a stored `feature:<name>:on|off` segment.
// Anything not in that exact shape returns null so the caller falls back to a full rebuild.
function parseOnOff(sig: string, name: string): boolean | null {
  const part = sig.split('|').find((p) => p.startsWith(`feature:${name}:`));
  if (part === undefined) return null;
  const fields = part.split(':');
  if (fields.length !== 3 || (fields[2] !== 'on' && fields[2] !== 'off')) return null;
  return fields[2] === 'on';
}

// Old-vs-new on/off for every changed feature key, or null when a segment can't be parsed back
// out of `before` or `after`, or when it parses to the same state on both sides (should never
// happen for a genuinely changed key) -- either way the caller takes the full rebuild.
export function classifyFeatureToggles(before: string, after: string, changedKeys: ReadonlySet<string>): FeatureToggle[] | null {
  const toggles: FeatureToggle[] = [];
  for (const key of changedKeys) {
    const name = key.slice('feature:'.length) as FeatureName;
    const wasOn = parseOnOff(before, name);
    const isOn = parseOnOff(after, name);
    if (wasOn === null || isOn === null || wasOn === isOn) return null;
    toggles.push({ name, turnedOn: isOn });
  }
  return toggles;
}
