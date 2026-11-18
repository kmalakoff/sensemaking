import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { downloadModelRevision, snapshotDir } from '../../../src/embed/store.ts';
import { SenseError } from '../../../src/errors.ts';
import { listen } from '../../lib/server.ts';
import { scratchDir } from '../../lib/tree.ts';

// Local HTTP server standing in for the Hub: no network. The tree response is built in each test.
const MODEL = 'test-org/test-model';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const WEIGHTS = Buffer.from('weights-bytes-0123456789');
const TOKENIZER = Buffer.from('{"vocab":["a","b"],"note":"git-blob fixture"}\n');
// Recorded from `git hash-object` on the TOKENIZER bytes, outside this code.
const TOKENIZER_GIT_SHA1 = '5c0308b0e2625455e744807f427e5cd1c7fc61bc';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const gitSha1 = (b: Buffer) => createHash('sha1').update(`blob ${b.byteLength}\0`).update(b).digest('hex');

interface Hub {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

interface Served {
  tree: unknown | number;
  files: Record<string, Buffer>;
}

async function startHub(served: Served): Promise<Hub> {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    if (path === `/api/models/${MODEL}/tree/${SHA}`) {
      if (typeof served.tree === 'number') {
        res.writeHead(served.tree);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(served.tree));
      return;
    }
    const prefix = `/${MODEL}/resolve/${SHA}/`;
    const body = path.startsWith(prefix) ? served.files[path.slice(prefix.length)] : undefined;
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(body);
  });
  const url = await listen(server);
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

const goodTree = (weights: Buffer = WEIGHTS) => [
  { type: 'file', path: 'model.safetensors', oid: 'a'.repeat(40), size: weights.byteLength, lfs: { oid: sha256(weights), size: weights.byteLength } },
  { type: 'file', path: 'tokenizer.json', oid: gitSha1(TOKENIZER), size: TOKENIZER.byteLength },
];

async function withHub(served: Served, run: (hub: Hub, root: string) => Promise<void>): Promise<void> {
  const hub = await startHub(served);
  try {
    await run(hub, scratchDir('model-hash'));
  } finally {
    await hub.close();
  }
}

async function rejection(promise: Promise<unknown>): Promise<SenseError> {
  const [outcome] = await Promise.allSettled([promise]);
  if (outcome.status === 'fulfilled') assert.fail('expected the download to reject');
  assert.ok(outcome.reason instanceof SenseError, String(outcome.reason));
  assert.equal(outcome.reason.code, 'EMBED_MODEL');
  return outcome.reason;
}

function assertNothingWritten(root: string, ...files: string[]): void {
  const dir = snapshotDir(MODEL, SHA, root);
  for (const file of files) assert.ok(!existsSync(join(dir, file)), `${file} must not exist`);
  assert.deepStrictEqual(
    readdirSync(dir).filter((f) => !files.includes(f) && f !== 'model.safetensors' && f !== 'tokenizer.json'),
    [],
    'no temporary file left behind'
  );
}

describe('downloadModelRevision verifies against the Hub hashes', () => {
  it('git hash of the fixture agrees with git itself', () => {
    assert.equal(gitSha1(TOKENIZER), TOKENIZER_GIT_SHA1);
  });

  it('writes an LFS file and a plain git file whose hashes match, byte for byte', async () => {
    const tree = [goodTree()[0], { type: 'file', path: 'tokenizer.json', oid: TOKENIZER_GIT_SHA1, size: TOKENIZER.byteLength }];
    await withHub({ tree, files: { 'model.safetensors': WEIGHTS, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const dir = await downloadModelRevision(MODEL, SHA, undefined, root, hub.url);
      assert.deepStrictEqual(readFileSync(join(dir, 'model.safetensors')), WEIGHTS);
      assert.deepStrictEqual(readFileSync(join(dir, 'tokenizer.json')), TOKENIZER);
    });
  });

  it('rejects an LFS file whose bytes differ from lfs.oid at the same size, writing nothing', async () => {
    const tampered = Buffer.from('weights-bytes-9876543210');
    assert.equal(tampered.byteLength, WEIGHTS.byteLength);
    await withHub({ tree: goodTree(), files: { 'model.safetensors': tampered, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
      assert.ok(err.message.includes(MODEL) && err.message.includes(SHA.slice(0, 8)) && err.message.includes('model.safetensors'), err.message);
      assert.ok(err.message.includes(sha256(WEIGHTS).slice(0, 12)), 'names the expected hash');
      assert.ok(err.message.includes(sha256(tampered).slice(0, 12)), 'names the actual hash');
      assert.ok(err.message.includes('/model.safetensors was not written'), err.message);
      assertNothingWritten(root, 'model.safetensors');
    });
  });

  it('rejects a wrong size before hashing, writing nothing', async () => {
    const longer = Buffer.concat([WEIGHTS, Buffer.from('x')]);
    await withHub({ tree: goodTree(), files: { 'model.safetensors': longer, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
      assert.ok(err.message.includes(`${longer.byteLength} bytes`) && err.message.includes(`${WEIGHTS.byteLength} bytes`), err.message);
      assert.ok(!err.message.includes(sha256(longer).slice(0, 12)), 'size is checked before the hash is computed');
      assertNothingWritten(root, 'model.safetensors');
    });
  });

  it('checks a git file with the git blob formula, not plain sha1 or sha256', async () => {
    for (const wrong of [createHash('sha1').update(TOKENIZER).digest('hex'), sha256(TOKENIZER)]) {
      const tree = [goodTree()[0], { type: 'file', path: 'tokenizer.json', oid: wrong, size: TOKENIZER.byteLength }];
      await withHub({ tree, files: { 'model.safetensors': WEIGHTS, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
        const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
        assert.ok(err.message.includes('tokenizer.json') && err.message.includes('git-sha1'), err.message);
        const dir = snapshotDir(MODEL, SHA, root);
        assert.ok(!existsSync(join(dir, 'tokenizer.json')));
        assert.deepStrictEqual(readFileSync(join(dir, 'model.safetensors')), WEIGHTS, 'the file verified earlier in the call stays');
      });
    }
  });

  it('rejects when the tree request returns 404, writing nothing', async () => {
    await withHub({ tree: 404, files: { 'model.safetensors': WEIGHTS, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
      assert.ok(err.message.includes('404') && err.message.includes('no model file was written'), err.message);
      assertNothingWritten(root, 'model.safetensors', 'tokenizer.json');
      assert.ok(!hub.requests.some((r) => r.includes('/resolve/')), 'no file was fetched');
    });
  });

  it('rejects when the tree has no entry for a needed file, writing nothing', async () => {
    await withHub({ tree: goodTree().slice(0, 1), files: { 'model.safetensors': WEIGHTS, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
      assert.ok(err.message.includes('tokenizer.json'), err.message);
      assertNothingWritten(root, 'model.safetensors', 'tokenizer.json');
    });
  });

  it('rejects a tree response that does not parse', async () => {
    await withHub({ tree: { not: 'a list' }, files: { 'model.safetensors': WEIGHTS, 'tokenizer.json': TOKENIZER } }, async (hub, root) => {
      const err = await rejection(downloadModelRevision(MODEL, SHA, undefined, root, hub.url));
      assert.ok(err.message.includes('unrecognized tree'), err.message);
      assertNothingWritten(root, 'model.safetensors', 'tokenizer.json');
    });
  });

  it('makes no request when both files are already present', async () => {
    await withHub({ tree: 500, files: {} }, async (hub, root) => {
      const dir = snapshotDir(MODEL, SHA, root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'model.safetensors'), 'on disk');
      writeFileSync(join(dir, 'tokenizer.json'), 'on disk');
      await downloadModelRevision(MODEL, SHA, undefined, root, hub.url);
      assert.deepStrictEqual(hub.requests, []);
    });
  });
});
