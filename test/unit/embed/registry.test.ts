import assert from 'node:assert';
import { createServer } from 'http';
import { listen } from '../../lib/server.ts';

// Registry behavior the providers share: rejection eviction and owner-declared languages.
describe('provider registry', () => {
  it('a rejected construction is retried, not cached for the process lifetime', async () => {
    const { getProvider } = await import('../../../src/embed/registry.ts');
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
    const { getProvider } = await import('../../../src/embed/registry.ts');
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
    const { getProvider } = await import('../../../src/embed/registry.ts');
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
