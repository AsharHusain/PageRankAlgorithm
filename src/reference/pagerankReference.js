// =====================================================================
// REFERENCE JAVASCRIPT IMPLEMENTATION -- NOT THE PRODUCTION PATH
// =====================================================================
//
// This used to be src/algorithm/pagerank.js, where it was the thing the
// UI actually displayed. It is no longer wired into the rendering path at
// all. It survives for exactly one purpose: a user-initiated cross-check
// that answers "does the C program agree with a completely independent
// implementation of the same recurrence?".
//
// RULES FOR THIS FILE
//   * Nothing here may be rendered as though it came from C.
//   * It is only ever called from the "Independent cross-check" button.
//   * If it ever disagrees with C, that is a bug worth investigating --
//     not something to paper over.
//
// The recurrence below intentionally mirrors c/serial_pagerank.c line for
// line, including the dangling-node redistribution, so that agreement is
// meaningful evidence rather than a coincidence of shared code.

export const DAMPING_DEFAULT = 0.85;
export const TOL_DEFAULT = 1e-6;
export const MAXITER_DEFAULT = 100;

/** Build the reverse-adjacency structure the recurrence walks. */
function prepare(N, edges) {
  const outdeg = new Array(N).fill(0);
  const inNeighbors = Array.from({ length: N }, () => []);
  for (const [u, v] of edges) {
    outdeg[u]++;
    inNeighbors[v].push(u);
  }
  return { N, outdeg, inNeighbors };
}

/**
 * Power iteration to convergence.
 *
 * graph: { nodeIds: number[], edges: [u, v][] } using the UI's own node
 * ids, which may be sparse; they are compacted here the same way the
 * backend compacts them before calling C.
 */
export function referenceRun(graph, { d = DAMPING_DEFAULT, tol = TOL_DEFAULT, maxIter = MAXITER_DEFAULT } = {}) {
  const index = new Map();
  graph.nodeIds.forEach((id, i) => index.set(id, i));
  const N = graph.nodeIds.length;
  if (N === 0) return { PR: [], iterations: 0, converged: true, finalDiff: 0 };

  const edges = graph.edges.map(([u, v]) => [index.get(u), index.get(v)]);
  const { outdeg, inNeighbors } = prepare(N, edges);

  let PR = new Array(N).fill(1 / N);
  let diff = 0;
  let converged = false;
  let iter = 0;

  for (; iter < maxIter; iter++) {
    let danglingSum = 0;
    for (let u = 0; u < N; u++) if (outdeg[u] === 0) danglingSum += PR[u];

    const newPR = new Array(N);
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (const u of inNeighbors[v]) sum += PR[u] / outdeg[u];
      newPR[v] = (1 - d) / N + d * (sum + danglingSum / N);
    }

    diff = 0;
    for (let i = 0; i < N; i++) diff += Math.abs(newPR[i] - PR[i]);
    PR = newPR;

    if (diff < tol) { iter++; converged = true; break; }
  }

  return { PR, iterations: iter, converged, finalDiff: diff };
}

/**
 * Compares a C result against this reference implementation, using the
 * exact parameters C reported back so the two runs are comparable.
 */
export function referenceCrossCheck(graph, cResult) {
  const ref = referenceRun(graph, {
    d: cResult.damping,
    tol: cResult.tolerance,
    maxIter: cResult.max_iterations,
  });

  let maxAbsDiff = 0;
  const n = Math.min(ref.PR.length, cResult.pagerank.length);
  for (let i = 0; i < n; i++) {
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(ref.PR[i] - cResult.pagerank[i]));
  }
  if (ref.PR.length !== cResult.pagerank.length) maxAbsDiff = Infinity;

  return { maxAbsDiff, iterations: ref.iterations, converged: ref.converged, referencePR: ref.PR };
}
