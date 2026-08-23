// Rows -> SQLite: core schema, reconcile loop, has(). Parsing lives in scan.ts;
// everything beyond frontmatter + content lives in src/features/.

export type { OpenResult } from './open.ts';
export { clearCache, DB_FILENAME, docCount, open, SCHEMA_VERSION } from './open.ts';
export { reconcile } from './reconcile.ts';
export { getMeta, setMeta } from './shared.ts';
