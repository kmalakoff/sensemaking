import type { DatabaseSync } from 'node:sqlite';
import type { FeatureName } from '../config.ts';
import type { FileStat } from '../scan.ts';

// A feature owns its schema, per-file extraction/storage, and any whole-vault pass.
// Adding a feature = one module here + one entry in the registry (index.ts).
export interface Feature {
  name: FeatureName;
  schema(db: DatabaseSync): void;
  // Pure, per file: raw is the full file, body the prose after frontmatter.
  extract?(raw: string, body: string): unknown;
  remove?(db: DatabaseSync, path: string): void;
  store?(db: DatabaseSync, path: string, extracted: unknown): void;
  // After all rows are current, inside the reconcile transaction (resolution, rank).
  afterReconcile?(db: DatabaseSync, files: FileStat[]): void;
}
