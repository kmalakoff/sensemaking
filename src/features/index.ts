import type { Config } from '../config.ts';
import { featureEnabled } from '../config.ts';
import { links } from './links.ts';
import { rank } from './rank.ts';
import { sections } from './sections.ts';
import type { Feature } from './types.ts';

// Registry order matters: rank reads the links table in afterReconcile.
export const FEATURES: Feature[] = [links, sections, rank];

export function activeFeatures(cfg: Config): Feature[] {
  return FEATURES.filter((feature) => featureEnabled(cfg, feature.name));
}

export { linkEdges } from './links.ts';
export type { Section } from './sections.ts';
export type { Feature } from './types.ts';
