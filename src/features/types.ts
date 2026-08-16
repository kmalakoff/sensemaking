import type { DatabaseSync } from 'node:sqlite';
import type { Config, FeatureName } from '../config.ts';
import type { FileStat } from '../scan.ts';

// What changed this reconcile, so afterReconcile hooks can act on the delta instead of
// re-reading the whole tree. `reparsed`/`added`/`vanished` are relPaths; `added` is the
// subset of `reparsed` that are brand-new files (not just modified). One delta object per
// reconcile: hooks communicate through it (links sets `linksChanged` for rank), and any
// state keyed on it dies with the reconcile -- including on ROLLBACK.
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
  // Pure, per file: raw is the full file, body the prose after frontmatter,
  // search the normalized title/summary strings.
  extract?(raw: string, body: string, search?: { title: string; summary: string }): unknown;
  remove?(db: DatabaseSync, path: string, delta: ReconcileDelta): void;
  store?(db: DatabaseSync, path: string, extracted: unknown, delta: ReconcileDelta): void;
  // After all rows are current, inside the reconcile transaction (resolution, rank).
  // Hooks run in registry order and communicate through fields on `delta`.
  afterReconcile?(db: DatabaseSync, delta: ReconcileDelta): void;
  // Per-file opt-out (currently only embed, via FileStat.embed): absent means the feature
  // applies to every file it's otherwise on for. Checked per file before extract/store so a
  // doc covered only by semantic-false presets gets no rows for it at all.
  enabledForFile?(cfg: Config, file: FileStat): boolean;
}
