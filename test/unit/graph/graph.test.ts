import assert from 'node:assert';
import type { Edge } from '../../../src/graph/graph.ts';
import { pagerank, personalizedRank } from '../../../src/graph/graph.ts';

function sum(scores: Map<string, number>): number {
  return [...scores.values()].reduce((a, b) => a + b, 0);
}

describe('pagerank: defaults', () => {
  it('damping defaults to 0.85 and iterations to 30', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: Edge[] = [
      ['a', 'b'],
      ['b', 'c'],
    ];
    const withDefaults = pagerank(nodes, edges);
    const explicit = pagerank(nodes, edges, { damping: 0.85, iterations: 30 });
    assert.deepStrictEqual(withDefaults, explicit);
  });

  it('a different damping or iteration count changes the result', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: Edge[] = [
      ['a', 'b'],
      ['b', 'c'],
    ];
    const withDefaults = pagerank(nodes, edges);
    assert.notDeepStrictEqual(withDefaults, pagerank(nodes, edges, { damping: 0.5 }));
    assert.notDeepStrictEqual(withDefaults, pagerank(nodes, edges, { iterations: 1 }));
  });
});

describe('pagerank: hand-computable 3-node case', () => {
  it('a symmetric 3-cycle stays exactly uniform at every iteration count', () => {
    // a -> b -> c -> a: every node has in-degree 1 and out-degree 1, so the update is
    // symmetric under rotation and the uniform base (1/3 each) is already the fixed point.
    const nodes = ['a', 'b', 'c'];
    const edges: Edge[] = [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ];
    for (const iterations of [1, 5, 30]) {
      const scores = pagerank(nodes, edges, { iterations });
      for (const node of nodes) assert.ok(Math.abs((scores.get(node) as number) - 1 / 3) < 1e-9, `${node}: ${scores.get(node)}`);
    }
  });
});

describe('pagerank: dangling-mass redistribution', () => {
  it("a dangling node's rank is redistributed across all nodes by the base distribution, not lost", () => {
    // a -> b, a -> c; b and c are dangling (no outbound edges). Their rank is redistributed
    // uniformly (the uniform base) each iteration, so the total stays normalized to ~1 and a
    // node with no inbound edges (a) still ends up with nonzero rank purely from that redistribution.
    const nodes = ['a', 'b', 'c'];
    const edges: Edge[] = [
      ['a', 'b'],
      ['a', 'c'],
    ];
    const scores = pagerank(nodes, edges);
    assert.ok(Math.abs(sum(scores) - 1) < 1e-6, `total should stay ~1: ${sum(scores)}`);
    assert.ok((scores.get('a') as number) > 0, 'a has no inbound edges, so its only rank comes from dangling redistribution');

    // Closed-form fixed point: b and c are symmetric dangling nodes, x = (2+d) / (2*(d+3)),
    // a = 1 - 2x, at the shipped default damping (0.85).
    const d = 0.85;
    const x = (2 + d) / (2 * (d + 3));
    const a = 1 - 2 * x;
    assert.ok(Math.abs((scores.get('b') as number) - x) < 1e-3, `b: ${scores.get('b')} vs ${x}`);
    assert.ok(Math.abs((scores.get('c') as number) - x) < 1e-3, `c: ${scores.get('c')} vs ${x}`);
    assert.ok(Math.abs((scores.get('a') as number) - a) < 1e-3, `a: ${scores.get('a')} vs ${a}`);
  });
});

describe('pagerank: personalized total===0 branch', () => {
  it('every personal weight landing on an unknown node (or <= 0) yields all-zero scores, not a divide-by-zero', () => {
    const nodes = ['a', 'b'];
    const edges: Edge[] = [['a', 'b']];
    const scores = pagerank(nodes, edges, { personal: new Map([['ghost', 1]]) });
    assert.deepStrictEqual(
      scores,
      new Map([
        ['a', 0],
        ['b', 0],
      ])
    );
  });

  it('a zero or negative personal weight on a real node is excluded the same way', () => {
    const nodes = ['a', 'b'];
    const edges: Edge[] = [['a', 'b']];
    const scores = pagerank(nodes, edges, {
      personal: new Map([
        ['a', 0],
        ['b', -1],
      ]),
    });
    assert.deepStrictEqual(
      scores,
      new Map([
        ['a', 0],
        ['b', 0],
      ])
    );
  });

  it('empty nodes list returns an empty map regardless of options', () => {
    assert.deepStrictEqual(pagerank([], []), new Map());
  });
});

describe('pagerank: personalized bias', () => {
  it('a seeded node keeps more rank than an unseeded, equally-connected node', () => {
    const nodes = ['seed', 'other', 'shared'];
    const edges: Edge[] = [
      ['seed', 'shared'],
      ['other', 'shared'],
    ];
    const scores = pagerank(nodes, edges, { personal: new Map([['seed', 1]]) });
    assert.ok((scores.get('seed') as number) > (scores.get('other') as number));
  });
});

describe('personalizedRank', () => {
  it('treats edges as undirected: a backlink-only neighbor still gains rank from a seed', () => {
    const nodes = ['seed', 'linksToSeed', 'unrelated'];
    const edges: Edge[] = [['linksToSeed', 'seed']]; // seed has no outbound edges at all
    const scores = personalizedRank(nodes, edges, new Map([['seed', 1]]));
    assert.ok((scores.get('linksToSeed') as number) > (scores.get('unrelated') as number));
  });

  it('is exactly pagerank on the doubled (undirected) edge set at damping 0.7 / 15 iterations', () => {
    const nodes = ['a', 'b', 'c'];
    const edges: Edge[] = [
      ['a', 'b'],
      ['b', 'c'],
    ];
    const seeds = new Map([['a', 1]]);
    const undirected: Edge[] = [
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'c'],
      ['c', 'b'],
    ];
    assert.deepStrictEqual(personalizedRank(nodes, edges, seeds), pagerank(nodes, undirected, { damping: 0.7, iterations: 15, personal: seeds }));
  });
});
