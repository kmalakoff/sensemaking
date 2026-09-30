import { SenseError } from '../errors.ts';

const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 10_000;
const DEFAULT_BASE_DELAY_MS = 200;

// Initial policy bounds small API/metadata responses separately from model-file downloads.
export const HTTP_ATTEMPT_TIMEOUT_MS = 30_000;
export const MODEL_FILE_ATTEMPT_TIMEOUT_MS = 5 * 60_000;

export type FetchRequestInit = Omit<RequestInit, 'signal'> & { signal?: never };

export interface FetchRetryOptions {
  signal?: AbortSignal;
  attemptTimeoutMs?: number;
  baseDelayMs?: number;
}

export interface BufferedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly body: ArrayBuffer;
  readonly url: string;
}

type ResponsePhase = 'response headers' | 'response body';

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return 'the configured embedding endpoint';
  }
}

function attemptController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  controller: AbortController;
  timeoutReason: object;
  cleanup: () => void;
} {
  callerSignal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutReason = {};
  const relayAbort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', relayAbort, { once: true });
  if (callerSignal?.aborted) relayAbort();
  const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs);
  return {
    controller,
    timeoutReason,
    cleanup: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', relayAbort);
    },
  };
}

function disposeResponse(response: Response, controller: AbortController): void {
  const cancellation = response.body && !response.bodyUsed ? response.body.cancel() : undefined;
  controller.abort();
  // The controller owns socket cleanup; observe stream cancellation without delaying the attempt.
  if (cancellation)
    void cancellation.then(
      () => undefined,
      () => undefined
    );
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
  });
}

function failedRequest(url: string, phase: ResponsePhase, attempts: number, timeoutMs: number, timedOut: boolean): SenseError {
  const endpoint = safeUrl(url);
  if (timedOut) {
    return new SenseError('EMBED_MODEL', `${endpoint} timed out after ${timeoutMs}ms while waiting for ${phase} (attempt ${attempts}/${MAX_ATTEMPTS}); check the embedding service and network`);
  }
  return new SenseError('EMBED_MODEL', `${endpoint} failed while waiting for ${phase} after ${attempts} attempts; check the embedding service and network`);
}

function buffered(response: Response, body: ArrayBuffer, requestUrl: string): BufferedResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body,
    url: safeUrl(response.url || requestUrl),
  };
}

// Each attempt covers response headers and the complete successful body. Retry cleanup and
// backoff honor one caller signal without transferring ownership of that signal.
export async function fetchWithRetry(url: string, init: FetchRequestInit, options: FetchRetryOptions = {}): Promise<BufferedResponse> {
  const timeoutMs = options.attemptTimeoutMs ?? HTTP_ATTEMPT_TIMEOUT_MS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    options.signal?.throwIfAborted();
    const { controller, timeoutReason, cleanup } = attemptController(options.signal, timeoutMs);
    let response: Response | undefined;
    let phase: ResponsePhase = 'response headers';
    let retryDelayMs: number | undefined;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS - 1) {
          const retryAfter = Number(response.headers.get('retry-after'));
          retryDelayMs = retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS) : baseDelayMs * 2 ** attempt;
          disposeResponse(response, controller);
        } else {
          disposeResponse(response, controller);
          options.signal?.throwIfAborted();
          return buffered(response, new ArrayBuffer(0), url);
        }
      } else {
        phase = 'response body';
        const body = await response.arrayBuffer();
        options.signal?.throwIfAborted();
        return buffered(response, body, url);
      }
    } catch {
      try {
        options.signal?.throwIfAborted();
      } finally {
        if (response) disposeResponse(response, controller);
      }
      const timedOut = controller.signal.reason === timeoutReason;
      if (attempt === MAX_ATTEMPTS - 1) throw failedRequest(url, phase, attempt + 1, timeoutMs, timedOut);
      retryDelayMs = baseDelayMs * 2 ** attempt;
    } finally {
      cleanup();
    }
    await sleep(retryDelayMs ?? baseDelayMs * 2 ** attempt, options.signal);
  }
  throw new Error('unreachable');
}

// Any HTTP response means the endpoint is up. Abort it immediately because status does not
// consume its body, and bound the headers wait for an air-gapped machine.
export async function probeReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  const { controller, cleanup } = attemptController(undefined, timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    disposeResponse(response, controller);
    return true;
  } catch {
    return false;
  } finally {
    cleanup();
  }
}
