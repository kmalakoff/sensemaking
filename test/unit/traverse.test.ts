import assert from 'node:assert';
import { findPath } from '../../src/traverse.ts';
import { openTree, tmpTree, writeNote } from '../lib/tree.ts';

// a -> b, a -> c, b -> d, c -> d, d -> e, e -> (dead link), o isolated
function makeGraph() {
  const baseDir = tmpTree();
  writeNote(baseDir, 'a.md', { body: 'See [[b]] and [[c]].' });
  writeNote(baseDir, 'b.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'c.md', { body: 'See [[d]].' });
  writeNote(baseDir, 'd.md', { body: 'See [[e]].' });
  writeNote(baseDir, 'e.md', { body: 'Dead link: [[ghost]].' });
  writeNote(baseDir, 'o.md', { body: 'solo, no links in or out' });
  const { db } = openTree(baseDir);
  return db;
}

describe('findPath', () => {
  it('undirected shortest path, tie-broken deterministically', () => {
    const db = makeGraph();
    const path = findPath(db, 'a.md', 'e.md');
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('same node: a single-element path', () => {
    const db = makeGraph();
    assert.deepEqual(findPath(db, 'a.md', 'a.md'), ['a.md']);
  });

  it('directed: follows outbound links only', () => {
    const db = makeGraph();
    const path = findPath(db, 'a.md', 'e.md', { directed: true });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('directed: no path against the arrows', () => {
    const db = makeGraph();
    assert.equal(findPath(db, 'e.md', 'a.md', { directed: true }), null);
  });

  it('undirected still finds a path against the arrows', () => {
    const db = makeGraph();
    const path = findPath(db, 'e.md', 'a.md');
    assert.deepEqual(path, ['e.md', 'd.md', 'b.md', 'a.md']);
  });

  it('unreachable: an isolated node returns null', () => {
    const db = makeGraph();
    assert.equal(findPath(db, 'a.md', 'o.md'), null);
  });

  it('maxDepth bounds the search: too short to reach', () => {
    const db = makeGraph();
    assert.equal(findPath(db, 'a.md', 'e.md', { maxDepth: 2 }), null);
  });

  it('maxDepth exactly enough still finds it', () => {
    const db = makeGraph();
    const path = findPath(db, 'a.md', 'e.md', { maxDepth: 3 });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });

  it('allowed reroutes around an excluded node, endpoints still permitted', () => {
    const db = makeGraph();
    const path = findPath(db, 'a.md', 'e.md', { allowed: new Set(['a.md', 'c.md', 'd.md', 'e.md']) });
    assert.deepEqual(path, ['a.md', 'c.md', 'd.md', 'e.md'], 'b.md excluded, so the route must go through c.md');
  });

  it('allowed still resolves an endpoint outside the set', () => {
    const db = makeGraph();
    // "to" (e.md) is deliberately left out of the allowed set; it must still be reachable
    // as the endpoint, per findPath's contract.
    const path = findPath(db, 'a.md', 'e.md', { allowed: new Set(['a.md', 'b.md', 'd.md']) });
    assert.deepEqual(path, ['a.md', 'b.md', 'd.md', 'e.md']);
  });
});
