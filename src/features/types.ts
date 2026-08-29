import type { Block } from '../chunk/index.ts';
import type { Config, FeatureName } from '../config/index.ts';
import type { FileStat } from '../scan/index.ts';
import type { Connection } from '../store/types.ts';

// What changed this reconcile, so hooks act on the delta rather than re-reading the tree.
// `added` is the brand-new subset of `reparsed`. Hooks communicate through this one object.
export interface ReconcileDelta {
  files: FileStat[];
  reparsed: string[];
  added: string[];
  vanished: string[];
  // Set by the links feature: the resolved edge set may differ from before this reconcile.
  linksChanged?: boolean;
}

// One doc's per-feature extracted value, as store()/remove() see it (reconcile.ts assembles
// these from ParsedDoc.extracted before calling a feature, once for the whole batch).
export interface ExtractedDoc {
  path: string;
  extracted: unknown;
}

// A feature owns its schema, per-file extraction, batched storage, and any whole-tree pass.
// Adding a feature = one module here + one entry in the registry (index.ts).
export interface Feature {
  name: FeatureName;
  schema(db: Connection): Promise<void>;
  // Pure, per file: raw is the full file, body the prose after frontmatter, search the
  // normalized title/summary strings, data the parsed frontmatter, cfg the resolved config
  // (mirrors enabledForFile's own cfg argument, for a feature whose extraction is config-tunable),
  // blocks the body already parsed once by parseFile, shared with a feature needing a parse tree.
  extract?(raw: string, body: string, search?: { title: string; summary: string }, data?: Record<string, unknown>, cfg?: Config, blocks?: Block[]): unknown;
  // Called once per reconcile (not per file) with every path whose rows need clearing: vanished
  // files, plus reparsed files that already had rows (a feature that diffs its own stale rows
  // in store() instead, e.g. links/tags, filters this list down to just delta.vanished itself).
  remove?(db: Connection, paths: string[], delta: ReconcileDelta): Promise<void>;
  // Called once per reconcile with every freshly parsed doc's extracted value, so a feature
  // writes its rows through one Connection.runBatch call instead of looping per file.
  store?(db: Connection, docs: ExtractedDoc[], delta: ReconcileDelta): Promise<void>;
  // After all rows are current, inside the reconcile transaction (resolution, rank).
  // Hooks run in registry order and communicate through fields on `delta`.
  afterReconcile?(db: Connection, delta: ReconcileDelta): Promise<void>;
  // Per-file opt-out (currently only embed, via FileStat.embed): absent means the feature
  // applies to every file it's otherwise on for. Checked per file before extract/store so a
  // doc in a tree with no embedding model gets no rows for it at all.
  enabledForFile?(cfg: Config, file: FileStat): boolean;
  // This feature's cache-identity segment for config.featureSignature, or undefined to
  // contribute nothing. Composed by access.ts in registry order (features/index.ts's FEATURES).
  signature?(cfg: Config): string | undefined;
}
