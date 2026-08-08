// Typed errors for library modules. Library code (config.ts, scan.ts,
// db.ts, watch.ts) never calls process.exit and never prints -- it throws.
// Only cli.ts catches, prints the message, and maps it to an exit code.
export type SenseErrorCode = 'CONFIG_NOT_FOUND' | 'CONFIG_EXISTS' | 'CONFIG_VERSION_UNSUPPORTED' | 'WATCH_ACTIVE';

export class SenseError extends Error {
  code: SenseErrorCode;

  constructor(code: SenseErrorCode, message: string) {
    super(message);
    this.name = 'SenseError';
    this.code = code;
  }
}
