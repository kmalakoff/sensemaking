import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { openaiProvider } from '../../../src/embed/openai.ts';
import { listen } from '../../lib/server.ts';

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
