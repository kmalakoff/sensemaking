import type { DatabaseSync } from 'node:sqlite';
import type { Block } from '../chunk/index.ts';
import type { Config, FeatureName } from '../config/index.ts';
import type { FileStat } from '../scan/index.ts';

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

// A feature owns its schema, per-file extraction/storage, and any whole-tree pass.
// Adding a feature = one module here + one entry in the registry (index.ts).
export interface Feature {
  name: FeatureName;
  schema(db: DatabaseSync): void;
  // Pure, per file: raw is the full file, body the prose after frontmatter, search the
  // normalized title/summary strings, data the parsed frontmatter, cfg the resolved config
  // (mirrors enabledForFile's own cfg argument, for a feature whose extraction is config-tunable),
  // blocks the body already parsed once by parseFile, shared with a feature needing a parse tree.
  extract?(raw: string, body: string, search?: { title: string; summary: string }, data?: Record<string, unknown>, cfg?: Config, blocks?: Block[]): unknown;
  remove?(db: DatabaseSync, path: string, delta: ReconcileDelta): void;
  store?(db: DatabaseSync, path: string, extracted: unknown, delta: ReconcileDelta): void;
  // After all rows are current, inside the reconcile transaction (resolution, rank).
  // Hooks run in registry order and communicate through fields on `delta`.
  afterReconcile?(db: DatabaseSync, delta: ReconcileDelta): void;
  // Per-file opt-out (currently only embed, via FileStat.embed): absent means the feature
  // applies to every file it's otherwise on for. Checked per file before extract/store so a
  // doc in a tree with no embedding model gets no rows for it at all.
  enabledForFile?(cfg: Config, file: FileStat): boolean;
  // This feature's cache-identity segment for config.featureSignature, or undefined to
  // contribute nothing. Composed by access.ts in registry order (features/index.ts's FEATURES).
  signature?(cfg: Config): string | undefined;
}
