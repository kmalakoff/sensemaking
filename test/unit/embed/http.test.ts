import assert from 'node:assert';
import { createServer } from 'http';
import { fetchWithRetry, probeReachable } from '../../../src/embed/http.ts';
import { listen } from '../../lib/server.ts';

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
    const res = await fetchWithRetry(url, {}, 10);
    server.close();
    assert.equal(res.status, 200);
    assert.equal(calls, 2, 'exactly one retry');
  });

  it('retries a 500, then succeeds', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 500 : 200);
      res.end();
    });
    const url = await listen(server);
    const res = await fetchWithRetry(url, {}, 10);
    server.close();
    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });

  it('fails immediately on 400, no retry', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(400);
      res.end();
    });
    const url = await listen(server);
    const res = await fetchWithRetry(url, {}, 10);
    server.close();
    assert.equal(res.status, 400);
    assert.equal(calls, 1, 'a non-retryable 4xx must not be retried');
  });
});

describe('reachability probe', () => {
  it('any HTTP response counts as reachable, even a 404', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const url = await listen(server);
    const ok = await probeReachable(url, 1000);
    server.close();
    assert.equal(ok, true);
  });

  it('a closed port reports unreachable', async () => {
    const probe = createServer();
    const url = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const ok = await probeReachable(url, 500);
    assert.equal(ok, false);
  });
});
