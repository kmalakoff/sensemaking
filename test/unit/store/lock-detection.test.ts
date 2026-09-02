import assert from 'node:assert';
import { duckdbOpenDialect } from '../../../src/store/duckdb/open.ts';
import { tursoOpenDialect } from '../../../src/store/turso/open.ts';

// isLocked decides whether connectUnlocked retries or gives up, and each engine words the refusal
// differently per platform. The Windows phrasings are absent from every posix run, so a matcher
// narrowed to posix passes locally and fails only on Windows CI, which is how it happened
// (run 33635519373). These are the verbatim messages from that run.
const LOCKED = {
  duckdb: [
    ['posix', 'IO Error: Could not set lock on file "/tmp/t/.sense/cache.duckdb": Conflicting lock is held in /usr/bin/node (PID 4242)'],
    ['windows', 'IO Error: Cannot open file "C:\\t\\.sense\\cache.duckdb": The process cannot access the file because it is being used by another process. File is already open in C:\\hostedtoolcache\\windows\\node\\26.8.1\\x64\\node.exe (PID 8792)'],
  ],
  turso: [
    ['posix', 'Locking error: Failed locking file, File is locked by another process'],
    ['windows', 'Locking error: Failed locking file, The process cannot access the file because another process has locked a portion of the file. (os error 33)'],
  ],
} as const;

// Errors that reach the same code path and must not be read as a lock, or a real failure would be
// retried until the budget ran out and then reported as contention.
const NOT_LOCKED = [
  'IO Error: Cannot open file "/t/.sense/cache.duckdb": No such file or directory',
  'IO Error: Cannot open file "/t/.sense/cache.duckdb": Permission denied',
  'Parser Error: syntax error at or near "SELCT"',
  'Locking error: Failed locking file, Input/output error (os error 5)',
  'database disk image is malformed',
];

describe('lock detection: both engines, both platforms', () => {
  for (const [engine, dialect] of [
    ['duckdb', duckdbOpenDialect],
    ['turso', tursoOpenDialect],
  ] as const) {
    for (const [platform, message] of LOCKED[engine]) {
      it(`${engine} recognises its ${platform} lock message`, () => {
        assert.ok(dialect.isLocked?.(new Error(message)), `${engine} must retry on: ${message}`);
      });
    }

    for (const message of NOT_LOCKED) {
      it(`${engine} does not read "${message.slice(0, 40)}..." as a lock`, () => {
        assert.equal(dialect.isLocked?.(new Error(message)), false, `${engine} must fail fast on: ${message}`);
      });
    }
  }
});
