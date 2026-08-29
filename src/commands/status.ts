import type { ResolvedConfig, SignalWeights } from '../config/index.ts';
import { anyPresetEmbeds, presetNames, presetSignals } from '../config/index.ts';
import type { Store } from '../store/types.ts';

export interface PresetCoverage {
  name: string;
  files: number;
  embedded: number;
  // Reported so 0 embedded reads as "this scope declined vectors" rather than "not yet built".
  signals: SignalWeights;
}

// Indexing derives from presets, so the derivation stays visible. Read from preset_files, not
// recomputed from globs, so it reflects the cache rather than the config.
export async function presetCoverage(store: Store, cfg: ResolvedConfig): Promise<PresetCoverage[]> {
  const embedActive = anyPresetEmbeds(cfg);
  const filesStmt = await store.prepare('SELECT COUNT(*) AS n FROM preset_files WHERE preset = ?');
  const embeddedStmt = embedActive ? await store.prepare('SELECT COUNT(*) AS n FROM preset_files pf WHERE pf.preset = ? AND EXISTS (SELECT 1 FROM embeddings e WHERE e."path" = pf."path" AND e.vector IS NOT NULL)') : null;
  // Sequential, not Promise.all: both statements are reused across presets, and a store's
  // prepared statement is not safe to bind/run concurrently with itself.
  const rows: PresetCoverage[] = [];
  for (const name of presetNames(cfg)) {
    const files = ((await filesStmt.get(name)) as { n: number }).n;
    const embedded = embeddedStmt ? ((await embeddedStmt.get(name)) as { n: number }).n : 0;
    rows.push({ name, files, embedded, signals: presetSignals(cfg, name) });
  }
  return rows;
}
