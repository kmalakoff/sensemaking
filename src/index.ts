// Public library API. Deliberately small: every export is a stability promise;
// internals (feature registry, graph, scan, meta) stay module-private.

export type { Peek, PresetCoverage, SearchOptions, TreeMap } from './commands/index.ts';
export { mapTree, peek, presetCoverage, search } from './commands/index.ts';
export type { Config, EmbedConfig, FeatureName, Preset, ResolvedConfig, SavedQuery, SavedSearch, SearchOverrides } from './config/index.ts';
export { CONFIG_FILENAME, initConfig, loadConfig, migrateConfig, STATE_DIR, SUPPORTED_CONFIG_VERSION } from './config/index.ts';
export type { OpenResult } from './db/index.ts';
export { clearCache, open } from './db/index.ts';
export type { SenseErrorCode } from './errors.ts';
export { SenseError } from './errors.ts';
export type { Format, Row, RowFormat } from './output.ts';
export { printRows } from './output.ts';

export type { WatchEvent, WatchOptions } from './watch.ts';
export { runWatch } from './watch.ts';
