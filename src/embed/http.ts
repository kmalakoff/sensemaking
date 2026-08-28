const MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared retry glue for the HTTP providers: 429/5xx/network failure retry with exponential
// backoff honoring Retry-After; any other status returns immediately for the caller to handle.
export async function fetchWithRetry(url: string, init: RequestInit, baseDelayMs = 200): Promise<Response> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || (res.status !== 429 && res.status < 500) || attempt === MAX_ATTEMPTS - 1) return res;
      const retryAfter = Number(res.headers.get('retry-after'));
      // Capped: a server naming a huge Retry-After must not stall an embed run for it.
      await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : baseDelayMs * 2 ** attempt);
    } catch (err) {
      if (attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw new Error('unreachable');
}

// Any HTTP response means the endpoint is up; only a network failure or the timeout counts as
// unreachable, so an air-gapped machine never waits more than timeoutMs on `sense status`.
export async function probeReachable(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
