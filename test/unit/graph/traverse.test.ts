import assert from 'node:assert';
import { findPath } from '../../../src/graph/traverse.ts';
import { openTree, tmpTree, writeNote } from '../../lib/tree.ts';

// a -> b, a -> c, b -> d, c -> d, d -> e, e -> (dead link), o isolated
async function makeGraph() {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
  writeNote(baseDir, 'b.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'c.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'd.md', { body: 'See [[e]].' });
  writeNote(baseDir, 'e.md', { body: 'Dead link: [[ghost]].' });
  writeNote(baseDir, 'o.md', { body: 'solo, no links in or out' });
  const { store } = await openTree(baseDir);
  return store;
}

describe('findPath', () => {
  it('undirected shortest path, tie-broken deterministically', async () => {
    const store = await makeGraph();
    const path = await findPath(store, 'a.md', 'e.md');
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('same node: a single-element path', async () => {
    const store = await makeGraph();
    assert.deepEqual(await findPath(store, 'a.md', 'a.md'), ['a.md']);
  });

  it('directed: follows outbound links only', async () => {
    const store = await makeGraph();
    const path = await findPath(store, 'a.md', 'e.md', { directed: true });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('directed: no path against the arrows', async () => {
    const store = await makeGraph();
    assert.equal(await findPath(store, 'e.md', 'a.md', { directed: true }), null);
  });

  it('undirected still finds a path against the arrows', async () => {
    const store = await makeGraph();
    const path = await findPath(store, 'e.md', 'a.md');
    assert.deepEqual(path, ['e.md', 'd.md', 'b.md', 'a.md']);
  });

  it('unreachable: an isolated node returns null', async () => {
    const store = await makeGraph();
    assert.equal(await findPath(store, 'a.md', 'o.md'), null);
  });

  it('maxDepth bounds the search: too short to reach', async () => {
    const store = await makeGraph();
    assert.equal(await findPath(store, 'a.md', 'e.md', { maxDepth: 2 }), null);
  });

  it('maxDepth exactly enough still finds it', async () => {
    const store = await makeGraph();
    const path = await findPath(store, 'a.md', 'e.md', { maxDepth: 3 });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('allowed reroutes around an excluded node, endpoints still permitted', async () => {
    const store = await makeGraph();
    const path = await findPath(store, 'a.md', 'e.md', { allowed: new Set(['a.md', 'c.md', 'd.md', 'e.md']) });
    assert.deepEqual(path, ['a.md', 'c.md', 'd.md', 'e.md'], 'b.md excluded, so the route must go through c.md');
  });

  it('allowed still resolves an endpoint outside the set', async () => {
    const store = await makeGraph();
    // "to" (e.md) is deliberately left out of the allowed set; it must still be reachable
    // as the endpoint, per findPath's contract.
    const path = await findPath(store, 'a.md', 'e.md', { allowed: new Set(['a.md', 'b.md', 'd.md']) });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });
});
