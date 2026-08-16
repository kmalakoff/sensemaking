// Library code throws; only cli.ts prints and exits.
export type SenseErrorCode = 'CONFIG_NOT_FOUND' | 'CONFIG_EXISTS' | 'CONFIG_INVALID' | 'CONFIG_VERSION_UNSUPPORTED' | 'WATCH_ACTIVE' | 'NOTE_NOT_FOUND' | 'NOTE_AMBIGUOUS' | 'EMBED_DISABLED' | 'EMBED_MODEL' | 'SEARCH_SYNTAX' | 'COLUMN_LIMIT' | 'PRESET_UNKNOWN';

export class SenseError extends Error {
  code: SenseErrorCode;

  constructor(code: SenseErrorCode, message: string) {
    super(message);
    this.name = 'SenseError';
    this.code = code;
  }
}
