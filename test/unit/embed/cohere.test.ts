import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { cohereProvider } from '../../../src/embed/cohere.ts';
import { listen } from '../../lib/server.ts';

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
