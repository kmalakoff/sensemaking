import assert from 'node:assert';
import { findPath, traverse } from '../../src/traverse.ts';
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

describe('traverse', () => {
  it('forward: rings expand along outbound links, seeds excluded', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['a.md'], direction: 'forward', depth: 3 });
    assert.deepEqual(
      result.map((r) => [r.path, r.depth]).sort(),
      [
        ['b.md', 1],
        ['c.md', 1],
        ['d.md', 2],
        ['e.md', 3],
      ].sort()
    );
  });

  it('reverse: rings expand along inbound links', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['e.md'], direction: 'reverse', depth: 3 });
    assert.deepEqual(
      result.map((r) => [r.path, r.depth]).sort(),
      [
        ['d.md', 1],
        ['b.md', 2],
        ['c.md', 2],
        ['a.md', 3],
      ].sort()
    );
  });

  it('both: undirected, walks either direction', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['d.md'], direction: 'both', depth: 2 });
    assert.deepEqual(
      result.map((r) => [r.path, r.depth]).sort(),
      [
        ['b.md', 1],
        ['c.md', 1],
        ['e.md', 1],
        ['a.md', 2],
      ].sort()
    );
  });

  it('depth stops the walk short of full reachability', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['a.md'], direction: 'forward', depth: 1 });
    assert.deepEqual(result.map((r) => r.path).sort(), ['b.md', 'c.md']);
  });

  it('dead (unresolved) links are never followed', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['e.md'], direction: 'forward', depth: 1 });
    assert.deepEqual(result, []);
  });

  it('an isolated node reaches nothing', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['o.md'], direction: 'both', depth: 3 });
    assert.deepEqual(result, []);
  });

  it('cap bounds nodes returned per ring', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['a.md'], direction: 'forward', depth: 1, cap: 1 });
    assert.equal(result.length, 1);
    assert.equal(result[0].path, 'b.md', 'deterministic tie-break: lexicographically first');
  });

  it('allowed restricts which nodes are walked into', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['a.md'], direction: 'forward', depth: 3, allowed: new Set(['c.md', 'd.md', 'e.md']) });
    assert.deepEqual(
      result.map((r) => [r.path, r.depth]).sort(),
      [
        ['c.md', 1],
        ['d.md', 2],
        ['e.md', 3],
      ].sort(),
      'b.md is excluded, so the only forward route left is through c.md'
    );
  });

  it('no allowed set: no restriction', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['a.md'], direction: 'forward', depth: 3 });
    assert.equal(result.length, 4);
  });

  it('multiple seeds expand together', () => {
    const db = makeGraph();
    const result = traverse(db, { seeds: ['b.md', 'c.md'], direction: 'forward', depth: 1 });
    assert.deepEqual(
      result.map((r) => r.path),
      ['d.md']
    );
  });
});

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
