// Link-graph math: PageRank at reconcile, personalized PageRank at query time. Pure JS, no deps.

export type Edge = [src: string, dst: string];

// Power iteration. `personal` biases both teleport and dangling mass toward seed nodes;
// without it this is plain PageRank (uniform base). Returns scores summing to ~1.
export function pagerank(nodes: string[], edges: Edge[], opts: { damping?: number; iterations?: number; personal?: Map<string, number> } = {}): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 30;
  const n = nodes.length;
  if (n === 0) return new Map();

  const index = new Map(nodes.map((node, i) => [node, i]));
  const out: number[][] = nodes.map(() => []);
  for (const [src, dst] of edges) {
    const si = index.get(src);
    const di = index.get(dst);
    if (si !== undefined && di !== undefined) out[si].push(di);
  }

  let base: number[];
  if (opts.personal) {
    base = nodes.map(() => 0);
    let total = 0;
    for (const [node, weight] of opts.personal) {
      const i = index.get(node);
      if (i !== undefined && weight > 0) {
        base[i] = weight;
        total += weight;
      }
    }
    if (total === 0) return new Map(nodes.map((node) => [node, 0]));
    base = base.map((b) => b / total);
  } else {
    base = nodes.map(() => 1 / n);
  }

  let rank = [...base];
  for (let iter = 0; iter < iterations; iter++) {
    const next = base.map((b) => (1 - damping) * b);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (out[i].length === 0) {
        dangling += rank[i];
        continue;
      }
      const share = (damping * rank[i]) / out[i].length;
      for (const j of out[i]) next[j] += share;
    }
    for (let i = 0; i < n; i++) next[i] += damping * dangling * base[i];
    rank = next;
  }
  return new Map(nodes.map((node, i) => [node, rank[i]]));
}

// Connective expansion: walk the graph (undirected -- backlinks relate as much as links)
// from a seed result set. Answers "what is linked to the notes that matched".
export function personalizedRank(nodes: string[], edges: Edge[], seeds: Map<string, number>): Map<string, number> {
  const undirected: Edge[] = [];
  for (const [src, dst] of edges) {
    undirected.push([src, dst], [dst, src]);
  }
  return pagerank(nodes, undirected, { damping: 0.7, iterations: 15, personal: seeds });
}
