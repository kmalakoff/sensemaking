import type { Config } from '../config/index.ts';
import { featureEnabled } from '../config/index.ts';
import { embed } from './embed.ts';
import { links } from './links.ts';
import { rank } from './rank.ts';
import { sections } from './sections.ts';
import { tags } from './tags.ts';
import type { Feature } from './types.ts';

// Registry order matters: rank reads the links table in afterReconcile.
export const FEATURES: Feature[] = [links, sections, tags, rank, embed];

export function activeFeatures(cfg: Config): Feature[] {
  return FEATURES.filter((feature) => featureEnabled(cfg, feature.name));
}

export { LINK_EDGES_SQL, linkEdges, toEdges } from './links.ts';
export type { Section } from './sections.ts';
export type { Feature } from './types.ts';
