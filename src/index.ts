// Public library API.

export type { Config, ResolvedConfig } from './config.ts';
export { CONFIG_FILENAME, findConfigPath, initConfig, loadConfig, STATE_DIR, SUPPORTED_CONFIG_VERSION } from './config.ts';

export type { OpenResult } from './db.ts';
export { DB_FILENAME, docCount, getMeta, open, rebuild, reconcile, setMeta } from './db.ts';

export type { SenseErrorCode } from './errors.ts';
export { SenseError } from './errors.ts';

export type { Row } from './output.ts';
export { printRows } from './output.ts';

export type { FileStat, ParsedDoc } from './scan.ts';
export { listFiles, parseFile } from './scan.ts';

export type { WatchEvent, WatchOptions } from './watch.ts';
export { runWatch } from './watch.ts';
