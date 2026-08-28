import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { cohereProvider } from '../../src/embed/cohere.ts';
import { fetchWithRetry, probeReachable } from '../../src/embed/http.ts';
import { openaiProvider } from '../../src/embed/openai.ts';
import { listen } from '../lib/server.ts';

interface CohereBody {
  model: string;
  input_type: string;
  texts: string[];
  embedding_types: string[];
}

describe('cohere provider', () => {
  let server: Server;
  let url: string;
  let bodies: CohereBody[] = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as CohereBody;
        bodies.push(body);
        const data = body.texts.map((t) => (/apple|pomme/i.test(t) ? [1, 0, 0, 0] : [0, 1, 0, 0]));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ embeddings: { float: data } }));
      });
    });
    url = await listen(server);
  });

  after(() => server.close());

  it('embedDocuments sends input_type search_document; embedQuery sends search_query', async () => {
    const provider = await cohereProvider('embed-v4.0', url, undefined);
    bodies = []; // drop the dims-probe call made during construction

    const docs = await provider.embedDocuments(['an apple orchard', 'stone wall']);
    assert.deepEqual(bodies.at(-1), { model: 'embed-v4.0', input_type: 'search_document', texts: ['an apple orchard', 'stone wall'], embedding_types: ['float'] });
    assert.deepEqual(Array.from(docs[0]), [1, 0, 0, 0]);

    const q = await provider.embedQuery('pomme please');
    assert.deepEqual(bodies.at(-1), { model: 'embed-v4.0', input_type: 'search_query', texts: ['pomme please'], embedding_types: ['float'] });
    assert.deepEqual(Array.from(q), [1, 0, 0, 0]);
  });

  it('fewer embeddings than inputs is an error, not a silent shift onto the wrong chunks', async () => {
    const short = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ embeddings: { float: [[0.1]] } }));
    });
    const shortUrl = await listen(short);
    const provider = await cohereProvider('embed-v4.0', shortUrl, undefined);
    await assert.rejects(() => provider.embedDocuments(['a', 'b', 'c']), /returned 1 embeddings for 3 inputs/);
    short.close();
  });

  it('a non-OK response names the endpoint and status', async () => {
    const badServer = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const badUrl = await listen(badServer);
    await assert.rejects(() => cohereProvider('embed-v4.0', badUrl, undefined), /\/v2\/embed -> HTTP 500/);
    badServer.close();
  });
});

interface OpenaiBody {
  model: string;
  input: string[];
}

describe('openai provider', () => {
  let server: Server;
  let url: string;
  let bodies: OpenaiBody[] = [];
  let headers: Record<string, string | string[] | undefined> = {};

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        headers = req.headers;
        const body = JSON.parse(raw) as OpenaiBody;
        bodies.push(body);
        const data = body.input.map((t) => ({ embedding: /apple|pomme/i.test(t) ? [1, 0, 0, 0] : [0, 1, 0, 0] }));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data }));
      });
    });
    url = await listen(server);
  });

  after(() => server.close());

  it('dims probe: constructing the provider posts once and reads the vector length', async () => {
    bodies = [];
    const provider = await openaiProvider('text-embed', url, undefined);
    assert.deepEqual(bodies, [{ model: 'text-embed', input: ['dimension probe'] }]);
    assert.equal(provider.dims, 4);
  });

  it('embedDocuments and embedQuery both post {model, input} to the same /embeddings endpoint', async () => {
    const provider = await openaiProvider('text-embed', url, undefined);
    bodies = []; // drop the dims-probe call made during construction

    const docs = await provider.embedDocuments(['an apple orchard', 'stone wall']);
    assert.deepEqual(bodies.at(-1), { model: 'text-embed', input: ['an apple orchard', 'stone wall'] });
    assert.deepEqual(Array.from(docs[0]), [1, 0, 0, 0]);

    const q = await provider.embedQuery('pomme please');
    assert.deepEqual(bodies.at(-1), { model: 'text-embed', input: ['pomme please'] });
    assert.deepEqual(Array.from(q), [1, 0, 0, 0]);
  });

  it('an authorization header is sent from the named env var, and omitted without one', async () => {
    process.env.TEST_OPENAI_KEY = 'sekret';
    try {
      await openaiProvider('text-embed', url, 'TEST_OPENAI_KEY');
      assert.equal(headers.authorization, 'Bearer sekret');
    } finally {
      delete process.env.TEST_OPENAI_KEY;
    }

    await openaiProvider('text-embed', url, undefined);
    assert.equal(headers.authorization, undefined);
  });

  it('batchCap is exposed for the caller to chunk by; embedDocuments sends whatever it is given', async () => {
    const provider = await openaiProvider('text-embed', url, undefined);
    assert.equal(provider.batchCap, 64);
    bodies = [];
    const texts = Array.from({ length: provider.batchCap + 5 }, (_, i) => `note ${i}`);
    await provider.embedDocuments(texts);
    assert.equal(bodies.length, 1, "the provider does not batch internally; that is query.ts's job");
    assert.equal(bodies[0].input.length, texts.length);
  });

  it('an out-of-order response is put back in input order by its index field', async () => {
    const outOfOrder = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        // The vectors the caller asked for, announced by index, delivered backwards.
        const { input } = JSON.parse(body) as { input: string[] };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: input.map((_, i) => ({ index: i, embedding: [i + 1] })).reverse() }));
      });
    });
    const outOfOrderUrl = await listen(outOfOrder);
    const provider = await openaiProvider('text-embed', outOfOrderUrl, undefined);
    const vectors = await provider.embedDocuments(['a', 'b', 'c']);
    assert.deepEqual(
      vectors.map((v) => v[0]),
      [1, 2, 3]
    );
    outOfOrder.close();
  });

  // The dims probe sends one input, so a server that always answers with one embedding
  // constructs fine and only breaks the contract on a real batch.
  it('fewer embeddings than inputs is an error, not a silent shift onto the wrong chunks', async () => {
    const short = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ embedding: [0.1] }] }));
    });
    const shortUrl = await listen(short);
    const provider = await openaiProvider('text-embed', shortUrl, undefined);
    await assert.rejects(() => provider.embedDocuments(['a', 'b', 'c']), /returned 1 embeddings for 3 inputs/);
    short.close();
  });

  it('a non-OK response names the endpoint and status', async () => {
    const badServer = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const badUrl = await listen(badServer);
    await assert.rejects(() => openaiProvider('text-embed', badUrl, undefined), /\/embeddings -> HTTP 500/);
    badServer.close();
  });
});

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

// Registry behavior the providers share: rejection eviction and owner-declared languages.
describe('provider registry', () => {
  it('a rejected construction is retried, not cached for the process lifetime', async () => {
    const { getProvider } = await import('../../src/embed/registry.ts');
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
    const { getProvider } = await import('../../src/embed/registry.ts');
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
    const { getProvider } = await import('../../src/embed/registry.ts');
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
