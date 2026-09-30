import assert from 'node:assert';
import { createServer } from 'http';
import { getProvider } from '../../../src/embed/registry.ts';
import type { EmbedProvider } from '../../../src/embed/types.ts';
import { listen } from '../../lib/server.ts';

async function settlementOf<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const [outcome] = await Promise.allSettled([promise]);
  return outcome;
}

// Registry behavior the providers share: rejection eviction and owner-declared languages.
describe('provider registry', () => {
  it('an already-aborted waiter preserves null and starts no shared probe', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.end();
    });
    const url = await listen(server);
    const cfg = { presets: { default: { include: ['**/*.md'] } }, embed: { model: `pre-abort-${Date.now()}`, provider: 'openai' as const, url }, queries: {} };
    const controller = new AbortController();
    controller.abort(null);
    let reason: unknown = Symbol('not rejected');
    try {
      try {
        await getProvider(cfg, { signal: controller.signal });
      } catch (err) {
        reason = err;
      }
      assert.strictEqual(reason, null);
      assert.equal(calls, 0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it('aborting one waiter does not abort another waiter or duplicate the shared probe', async () => {
    let calls = 0;
    let releaseProbe: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probeStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const server = createServer(async (_req, res) => {
      calls++;
      markStarted?.();
      await probeReleased;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    const url = await listen(server);
    const cfg = { presets: { default: { include: ['**/*.md'] } }, embed: { model: `shared-wait-${Date.now()}`, provider: 'openai' as const, url }, queries: {} };
    const controller = new AbortController();
    const reason = { operation: 'detached' };
    let outcomesPromise: Promise<PromiseSettledResult<EmbedProvider>[]> | undefined;
    let outcomes: PromiseSettledResult<EmbedProvider>[] | undefined;
    try {
      const departing = getProvider(cfg, { signal: controller.signal });
      const departingOutcome = settlementOf(departing);
      const remaining = getProvider(cfg);
      const remainingOutcome = settlementOf(remaining);
      outcomesPromise = Promise.all([departingOutcome, remainingOutcome]);
      const readiness = await Promise.race([probeStarted.then(() => 'probe-started' as const), Promise.race([departingOutcome, remainingOutcome]).then(() => 'waiter-settled' as const)]);
      assert.equal(readiness, 'probe-started', 'the shared probe must start before either waiter settles');
      controller.abort(reason);
    } finally {
      releaseProbe?.();
      if (outcomesPromise) outcomes = await outcomesPromise;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    assert.ok(outcomes);
    const [departingOutcome, remainingOutcome] = outcomes;
    assert.equal(departingOutcome.status, 'rejected');
    if (departingOutcome.status === 'rejected') assert.strictEqual(departingOutcome.reason, reason);
    assert.equal(remainingOutcome.status, 'fulfilled');
    if (remainingOutcome.status === 'fulfilled') assert.equal(remainingOutcome.value.dims, 2);
    assert.equal(calls, 1);
  });

  it('a rejected construction is retried, not cached for the process lifetime', async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(400).end('{}'); // non-retryable, fails the dims probe
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    const url = await listen(server);
    const cfg = { presets: { default: { include: ['**/*.md'] } }, embed: { model: `evict-${Date.now()}`, provider: 'openai' as const, url }, queries: {} };
    await assert.rejects(() => getProvider(cfg), /HTTP 400/);
    const provider = await getProvider(cfg); // second attempt reaches the recovered server
    assert.equal(provider.dims, 2);
    server.close();
  });

  it('two trees sharing an endpoint and model but declaring different languages get their own provider', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    const url = await listen(server);
    const model = `shared-${Date.now()}`;
    const tree = (languages: string[]) => ({ presets: { default: { include: ['**/*.md'] } }, embed: { model, provider: 'openai' as const, url, languages }, queries: {} });
    assert.deepEqual((await getProvider(tree(['en']))).languages, ['en']);
    assert.deepEqual((await getProvider(tree(['en', 'zh']))).languages, ['en', 'zh']);
    server.close();
  });

  it('embed.languages overrides the provider and feeds the fit check', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    const url = await listen(server);
    const cfg = { presets: { default: { include: ['**/*.md'] } }, embed: { model: `langs-${Date.now()}`, provider: 'openai' as const, url, languages: ['en', 'zh'] }, queries: {} };
    const provider = await getProvider(cfg);
    assert.deepEqual(provider.languages, ['en', 'zh']);
    server.close();
  });
});
