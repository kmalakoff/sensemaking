// Public library API. Deliberately small: every export is a stability promise;
// internals (feature registry, graph, scan, meta) stay module-private.

export type { Peek, PresetCoverage, SearchOptions, TreeMap } from './commands/index.ts';
export { mapTree, peek, presetCoverage, search } from './commands/index.ts';
export type { Config, EmbedConfig, FeatureName, InitOverrides, Preset, ResolvedConfig, SavedQuery, SavedSearch, SearchOverrides, SignalName, SignalWeights, StoreName } from './config/index.ts';
export { CONFIG_FILENAME, initConfig, loadConfig, migrateConfig, SIGNAL_NAMES, STATE_DIR, STORE_NAMES, SUPPORTED_CONFIG_VERSION } from './config/index.ts';
export type { SenseErrorCode } from './errors.ts';
export { SenseError } from './errors.ts';
export type { Format, Row, RowFormat } from './output/output.ts';
export { printRows } from './output/output.ts';
export type { OpenResult, Stages } from './store/index.ts';
export { CAPABILITY_NAMES, clearCache, openStore as open } from './store/index.ts';
export type { Capability, DocumentStore, FieldStat, LexicalHit, LexicalIndex, LexicalQueryOptions, RawStatement, RunResult, SqlSession, Statement, Store, VectorCandidate, VectorSimilar, VectorStore, VectorWriteRow } from './store/types.ts';

export type { WatchEvent, WatchOptions } from './watch.ts';
export { runWatch } from './watch.ts';
