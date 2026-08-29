import type { Config } from '../config/index.ts';
import type { Feature } from '../features/types.ts';
import type { ParsedDoc } from './index.ts';
import { parseFile } from './index.ts';
import type { FileStat } from './list.ts';

// Store-agnostic per-file parse pass shared by every store's reconcile(). Index-preserving by
// construction (one pass over `files`, pushed in order) so a future concurrent dispatch can
// replace the loop body without changing this contract or either call site.
export interface ReparseResult {
  docs: ParsedDoc[];
  warnings: string[];
  // Frontmatter keys not in `knownColumns`, first-seen order across `files` -- the order
  // callers ALTER TABLE ADD COLUMN in.
  newColumns: string[];
}

// `onParsed` receives the running count (1-based) after each file, mirroring a Progress.tick
// call; pass one in to keep progress reporting working without this module owning a reporter.
export function reparseFiles(files: FileStat[], features: Feature[], cfg: Config, knownColumns: ReadonlySet<string>, onParsed?: (done: number) => void): ReparseResult {
  const docs: ParsedDoc[] = [];
  const warnings: string[] = [];
  const newColumns: string[] = [];
  const seen = new Set(knownColumns);
  let done = 0;

  for (const file of files) {
    // A doc only gets extract/store from features that apply to it (currently: embed, via
    // FileStat.embed -- true iff the config names an embedding model).
    const fileFeatures = features.filter((feature) => !feature.enabledForFile || feature.enabledForFile(cfg, file));
    const { doc, warnings: fileWarnings } = parseFile(file, fileFeatures, cfg);
    onParsed?.(++done);
    warnings.push(...fileWarnings);
    for (const key of Object.keys(doc.data)) {
      if (!seen.has(key)) {
        seen.add(key);
        newColumns.push(key);
      }
    }
    docs.push(doc);
  }

  return { docs, warnings, newColumns };
}
