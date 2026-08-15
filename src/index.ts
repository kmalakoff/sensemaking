// Public library API. Deliberately small: every export is a stability promise;
// internals (feature registry, graph, scan, meta) stay module-private.

export type { FindOptions, Peek, TreeMap } from './commands.ts';
export { find, mapTree, peek } from './commands.ts';
export type { Config, EmbedConfig, FeatureName, ResolvedConfig, SavedFind } from './config.ts';
export { CONFIG_FILENAME, initConfig, loadConfig, migrateConfig, STATE_DIR, SUPPORTED_CONFIG_VERSION } from './config.ts';
export type { OpenResult } from './db.ts';
export { open, rebuild } from './db.ts';
export type { SenseErrorCode } from './errors.ts';
export { SenseError } from './errors.ts';
export type { Row } from './output.ts';
export { printRows } from './output.ts';

export type { WatchEvent, WatchOptions } from './watch.ts';
export { runWatch } from './watch.ts';
