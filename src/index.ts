// Public library API.

export type { Config, FeatureName, ResolvedConfig } from './config.ts';
export { CONFIG_FILENAME, enabledFeatures, FEATURE_NAMES, featureEnabled, findConfigPath, initConfig, loadConfig, migrateConfig, STATE_DIR, SUPPORTED_CONFIG_VERSION } from './config.ts';

export type { OpenResult } from './db.ts';
export { DB_FILENAME, docCount, getMeta, open, rebuild, reconcile, setMeta } from './db.ts';
export type { SenseErrorCode } from './errors.ts';
export { SenseError } from './errors.ts';
export { activeFeatures, FEATURES, linkEdges } from './features/index.ts';
export type { Section } from './features/sections.ts';
export type { Feature } from './features/types.ts';

export type { Edge } from './graph.ts';
export { pagerank, personalizedRank } from './graph.ts';

export type { Row } from './output.ts';
export { printRows } from './output.ts';

export type { FileStat, ParsedDoc } from './scan.ts';
export { listFiles, parseFile } from './scan.ts';

export type { FindOptions, Peek, VaultMap } from './verbs.ts';
export { find, peek, vaultMap } from './verbs.ts';

export type { WatchEvent, WatchOptions } from './watch.ts';
export { runWatch } from './watch.ts';
