import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { fetchWithRetry, probeReachable } from '../../../src/embed/http.ts';
import { listen } from '../../lib/server.ts';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeAllConnections();
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await settlementOf(promise);
  if (outcome.status === 'rejected') return outcome.reason;
  assert.fail('expected the promise to reject');
}

async function settlementOf<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [outcome] = await Promise.allSettled([promise]);
  return outcome;
}

describe('http retry', () => {
  it('retries a 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '0.01' });
        res.end();
      } else {
        res.writeHead(200);
        res.end();
      }
    });
    const url = await listen(server);
    try {
      const res = await fetchWithRetry(url, {}, { baseDelayMs: 10 });
      assert.equal(res.status, 200);
      assert.equal(calls, 2, 'exactly one retry');
    } finally {
      await closeServer(server);
    }
  });

  it('retries a 500, then succeeds', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 500 : 200);
      res.end();
    });
    const url = await listen(server);
    try {
      const res = await fetchWithRetry(url, {}, { baseDelayMs: 10 });
      assert.equal(res.status, 200);
      assert.equal(calls, 2);
    } finally {
      await closeServer(server);
    }
  });

  it('returns a terminal 400 without retrying and disposes its unused body', async () => {
    let calls = 0;
    let markClosed: (() => void) | undefined;
    const bodyClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(400);
      res.write('unused error body');
      res.on('close', () => markClosed?.());
    });
    const url = await listen(server);
    try {
      const res = await fetchWithRetry(url, {}, { baseDelayMs: 10 });
      assert.equal(res.status, 400);
      assert.equal(calls, 1, 'a non-retryable 4xx must not be retried');
      await bodyClosed;
    } finally {
      await closeServer(server);
    }
  });

  it('bounds stalled response headers and removes query and fragment secrets from the terminal error', async () => {
    let calls = 0;
    const server = createServer(() => {
      calls++;
    });
    const base = await listen(server);
    const endpoint = new URL(base);
    endpoint.searchParams.set('token', 'diagnostic-secret');
    endpoint.hash = 'diagnostic-fragment';
    try {
      const failure = await rejectionOf(fetchWithRetry(endpoint.href, {}, { attemptTimeoutMs: 50, baseDelayMs: 1 }));
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /timed out after 50ms while waiting for response headers \(attempt 3\/3\)/);
      assert.doesNotMatch(failure.message, /diagnostic-secret|diagnostic-fragment|token/);
      assert.equal(calls, 3);
    } finally {
      await closeServer(server);
    }
  });

  it('redacts credentials when fetch rejects a credential-bearing URL before sending a request', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.end();
    });
    const base = await listen(server);
    const endpoint = new URL(base);
    endpoint.username = 'diagnostic-user';
    endpoint.password = 'diagnostic-password';
    endpoint.searchParams.set('token', 'diagnostic-secret');
    try {
      const failure = await rejectionOf(fetchWithRetry(endpoint.href, {}, { attemptTimeoutMs: 50, baseDelayMs: 1 }));
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /failed while waiting for response headers after 3 attempts/);
      assert.doesNotMatch(failure.message, /timed out|diagnostic-user|diagnostic-password|diagnostic-secret|token/);
      assert.equal(calls, 0, 'fetch must reject the credential-bearing URL before transport');
    } finally {
      await closeServer(server);
    }
  });

  it('bounds a stalled successful response body on every attempt', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    const url = await listen(server);
    try {
      const failure = await rejectionOf(fetchWithRetry(url, {}, { attemptTimeoutMs: 50, baseDelayMs: 1 }));
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /timed out after 50ms while waiting for response body \(attempt 3\/3\)/);
      assert.equal(calls, 3);
    } finally {
      await closeServer(server);
    }
  });

  it('preserves a non-Error caller reason when aborted during Retry-After backoff', async () => {
    let calls = 0;
    let markClosed: (() => void) | undefined;
    const responseClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(429, { 'retry-after': '10' });
      res.write('unused retry body');
      res.on('close', () => markClosed?.());
    });
    const url = await listen(server);
    const controller = new AbortController();
    const reason = { operation: 'cancelled' };
    const pending = fetchWithRetry(url, {}, { signal: controller.signal, attemptTimeoutMs: 1000, baseDelayMs: 1 });
    const outcome = settlementOf(pending);
    try {
      const readiness = await Promise.race([responseClosed.then(() => 'response-closed' as const), outcome.then(() => 'request-settled' as const)]);
      assert.equal(readiness, 'response-closed', 'the request must reach backoff before it settles');
      controller.abort(reason);
      const result = await outcome;
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.strictEqual(result.reason, reason);
      assert.equal(calls, 1, 'caller abort must not submit another attempt');
    } finally {
      controller.abort(reason);
      await outcome;
      await closeServer(server);
    }
  });
});

describe('reachability probe', () => {
  it('any HTTP response counts as reachable and its unread body is disposed', async () => {
    let markClosed: (() => void) | undefined;
    const bodyClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.write('unused probe body');
      res.on('close', () => markClosed?.());
    });
    const url = await listen(server);
    try {
      const ok = await probeReachable(url, 1000);
      assert.equal(ok, true);
      await bodyClosed;
    } finally {
      await closeServer(server);
    }
  });

  it('a closed port reports unreachable', async () => {
    const probe = createServer();
    const url = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const ok = await probeReachable(url, 500);
    assert.equal(ok, false);
  });
});
