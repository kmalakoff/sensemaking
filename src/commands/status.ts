import type { DatabaseSync } from 'node:sqlite';
import type { ResolvedConfig } from '../config/index.ts';
import { anyPresetEmbeds, presetNames, presetSemanticEnabled } from '../config/index.ts';

export interface PresetCoverage {
  name: string;
  files: number;
  embedded: number;
  // Reported so 0 embedded reads as "this scope declined vectors" rather than "not yet built".
  semantic: boolean;
}

// Indexing derives from presets, so the derivation stays visible. Read from preset_files, not
// recomputed from globs, so it reflects the cache rather than the config.
export function presetCoverage(db: DatabaseSync, cfg: ResolvedConfig): PresetCoverage[] {
  const embedActive = anyPresetEmbeds(cfg);
  return presetNames(cfg).map((name) => {
    const files = (db.prepare('SELECT COUNT(*) AS n FROM preset_files WHERE preset = ?').get(name) as { n: number }).n;
    const embedded = embedActive ? (db.prepare('SELECT COUNT(*) AS n FROM preset_files pf WHERE pf.preset = ? AND EXISTS (SELECT 1 FROM embeddings e WHERE e."path" = pf."path" AND e.vector IS NOT NULL)').get(name) as { n: number }).n : 0;
    return { name, files, embedded, semantic: presetSemanticEnabled(cfg, name) };
  });
}
