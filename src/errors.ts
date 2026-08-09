// Library code throws; only cli.ts prints and exits.
export type SenseErrorCode = 'CONFIG_NOT_FOUND' | 'CONFIG_EXISTS' | 'CONFIG_VERSION_UNSUPPORTED' | 'WATCH_ACTIVE';

export class SenseError extends Error {
  code: SenseErrorCode;

  constructor(code: SenseErrorCode, message: string) {
    super(message);
    this.name = 'SenseError';
    this.code = code;
  }
}
