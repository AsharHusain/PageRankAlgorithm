// Graph construction, layout and editing helpers for the interactive
// editor.
//
// NOTE ON SCOPE: nothing in this file computes PageRank. It only builds
// and edits the graph that gets sent to the C backend, and decides where
// to draw the nodes. Ranks always arrive from the server.

export const CANVAS = { width: 900, height: 520 };

// The canonical 6-node demonstration graph from the assignment. Node 5 is
// a dangling node (no out-links), which is what makes it a useful test.
export const DEMO_GRAPH = {
  nodeIds: [0, 1, 2, 3, 4, 5],
  edges: [[0, 1], [0, 2], [1, 2], [2, 0], [3, 0], [3, 2], [4, 3], [4, 5]],
  positions: {
    0: [605, 150],
    1: [790, 96],
    2: [790, 315],
    3: [492, 438],
    4: [310, 246],
    5: [113, 246],
  },
};

export function cloneGraph(g) {
  return {
    nodeIds: [...g.nodeIds],
    edges: g.edges.map((e) => [e[0], e[1]]),
    positions: Object.fromEntries(Object.entries(g.positions).map(([k, v]) => [k, [...v]])),
  };
}

export function emptyGraph() {
  return { nodeIds: [], edges: [], positions: {} };
}

export function loadDemoGraph() {
  return cloneGraph(DEMO_GRAPH);
}

/** Smallest non-negative integer not already used as a node id. */
export function nextNodeId(graph) {
  const used = new Set(graph.nodeIds);
  let id = 0;
  while (used.has(id)) id++;
  return id;
}

export function addNode(graph, x, y) {
  const g = cloneGraph(graph);
  const id = nextNodeId(g);
  g.nodeIds.push(id);
  g.positions[id] = [
    Math.max(40, Math.min(CANVAS.width - 40, x)),
    Math.max(40, Math.min(CANVAS.height - 40, y)),
  ];
  return g;
}

export function removeNode(graph, id) {
  const g = cloneGraph(graph);
  g.nodeIds = g.nodeIds.filter((n) => n !== id);
  g.edges = g.edges.filter(([u, v]) => u !== id && v !== id);
  delete g.positions[id];
  return g;
}

export function hasEdge(graph, u, v) {
  return graph.edges.some(([a, b]) => a === u && b === v);
}

export function addEdge(graph, u, v) {
  if (!graph.nodeIds.includes(u) || !graph.nodeIds.includes(v)) return graph;
  if (hasEdge(graph, u, v)) return graph;      // the editor never makes duplicates
  const g = cloneGraph(graph);
  g.edges.push([u, v]);
  return g;
}

export function removeEdge(graph, u, v) {
  const g = cloneGraph(graph);
  g.edges = g.edges.filter(([a, b]) => !(a === u && b === v));
  return g;
}

export function moveNode(graph, id, x, y) {
  const g = cloneGraph(graph);
  g.positions[id] = [
    Math.max(28, Math.min(CANVAS.width - 28, x)),
    Math.max(28, Math.min(CANVAS.height - 28, y)),
  ];
  return g;
}

/** Lay nodes out evenly on a circle -- used for generated graphs. */
export function circularLayout(nodeIds) {
  const n = nodeIds.length;
  const cx = CANVAS.width / 2;
  const cy = CANVAS.height / 2;
  const r = Math.min(CANVAS.width, CANVAS.height) / 2 - 60;
  const positions = {};
  nodeIds.forEach((id, i) => {
    const a = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
    positions[id] = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  return positions;
}

/**
 * Builds a random directed graph for the editor.
 *
 * This is graph *construction*, not PageRank: the resulting graph is sent
 * to C exactly like a hand-drawn one.
 */
export function randomGraph(nodeCount, edgeCount) {
  const n = Math.max(0, Math.min(200, Math.floor(nodeCount)));
  const nodeIds = Array.from({ length: n }, (_, i) => i);
  const maxEdges = n * (n - 1);
  const m = Math.max(0, Math.min(Math.floor(edgeCount), maxEdges));

  const chosen = new Set();
  const edges = [];
  let guard = 0;
  while (edges.length < m && guard < m * 50 + 1000) {
    guard++;
    const u = Math.floor(Math.random() * n);
    const v = Math.floor(Math.random() * n);
    if (u === v) continue;                       // no self-loops in generated graphs
    const key = `${u}>${v}`;
    if (chosen.has(key)) continue;
    chosen.add(key);
    edges.push([u, v]);
  }

  return { nodeIds, edges, positions: circularLayout(nodeIds) };
}

/** Out-degree per node id -- used to flag dangling nodes in the editor. */
export function outDegrees(graph) {
  const deg = Object.fromEntries(graph.nodeIds.map((id) => [id, 0]));
  for (const [u] of graph.edges) if (u in deg) deg[u]++;
  return deg;
}

export function graphStats(graph) {
  const deg = outDegrees(graph);
  const dangling = graph.nodeIds.filter((id) => deg[id] === 0);
  return {
    nodes: graph.nodeIds.length,
    edges: graph.edges.length,
    dangling: dangling.length,
    danglingIds: dangling,
  };
}

/** A stable fingerprint, so the UI can tell when a result went stale. */
export function graphSignature(graph) {
  const edges = graph.edges.map(([u, v]) => `${u}>${v}`).sort().join(',');
  return `${[...graph.nodeIds].sort((a, b) => a - b).join(',')}|${edges}`;
}
