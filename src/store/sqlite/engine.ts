import { type EnginePatch, engineIdentity, selectBuilders } from '../engine.ts';

// node:sqlite is Node's bundled SQLite, so its version changes with Node rather than with an npm install.
export const SQLITE_ENGINE = 'node:sqlite';
export const SQLITE_VERSION: string | undefined = process.versions.sqlite;

// unicode61 splits on spaces, so a language written without them indexes a whole run as one
// token and word search finds nothing; the `_seg` sidecars (always populated) cover that case.
export const TOKENIZE = 'porter unicode61';

// Every FTS5 statement this store depends on; a SQLite version that behaves differently gets a SQLITE_PATCHES entry.
export interface SqliteFtsBuilders {
  // The `_seg` sidecars are appended after path, never inserted: bm25() and snippet(content, 2)
  // are documented against the first three columns. Each holds its field's exploded unspaced runs.
  createContent(): string;
  // One bound parameter, the FTS5 MATCH expression; ranked by field-weighted bm25.
  rankedMatch(whereJoin: string, whereCond: string, scopeCond: string, limit: number): string;
}

export const SQLITE_FTS_BUILDERS: SqliteFtsBuilders = {
  createContent: () => `CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(title, summary, text, path UNINDEXED, title_seg, summary_seg, text_seg, tokenize = '${TOKENIZE}')`,
  rankedMatch: (whereJoin, whereCond, scopeCond, limit) => `SELECT content.path AS path FROM content ${whereJoin} WHERE content MATCH ? ${whereCond} ${scopeCond} ORDER BY bm25(content, 10.0, 5.0, 1.0, 0, 10.0, 5.0, 1.0) LIMIT ${limit}`,
};

export const SQLITE_PATCHES: readonly EnginePatch<SqliteFtsBuilders>[] = [];

export const sqliteIdentity = (): string => engineIdentity(SQLITE_ENGINE, SQLITE_VERSION);

export function sqliteFts(): SqliteFtsBuilders {
  return selectBuilders(SQLITE_FTS_BUILDERS, SQLITE_PATCHES, SQLITE_VERSION);
}
