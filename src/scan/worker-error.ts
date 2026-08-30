import { SenseError, type SenseErrorCode } from '../errors.ts';

// Structured clone across a worker_threads boundary drops a subclass and its custom
// properties, so a SenseError arrives as a plain Error with `code` undefined -- and `code`
// drives caller behavior. The worker serializes explicitly (computed on its side, where
// `instanceof SenseError` is still meaningful) and the main thread rebuilds by hand.
export interface WorkerErrorPayload {
  name: string;
  code?: SenseErrorCode;
  message: string;
  stack?: string;
}

export function serializeError(err: unknown): WorkerErrorPayload {
  if (err instanceof Error) return { name: err.name, code: err instanceof SenseError ? err.code : undefined, message: err.message, stack: err.stack };
  return { name: 'Error', message: String(err) };
}

export function reviveError(payload: WorkerErrorPayload): Error {
  const err = payload.code ? new SenseError(payload.code, payload.message) : new Error(payload.message);
  err.name = payload.name;
  if (payload.stack) err.stack = payload.stack;
  return err;
}
