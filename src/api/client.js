// Thin fetch wrapper around the PageRank API.
//
// Everything this module returns was computed by a C process on the
// server. There is no client-side fallback: if the request fails, the UI
// shows an error rather than quietly substituting a JavaScript result.

async function postJson(url, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new Error(`Could not reach the PageRank server. Is \`npm run dev\` still running? (${err.message})`);
  }

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`Server returned a non-JSON response (HTTP ${res.status}).`);
  }

  if (!res.ok || payload.ok === false) {
    const err = new Error(payload.error || `Request failed with HTTP ${res.status}`);
    err.detail = payload.detail;
    err.origin = payload.origin;
    err.status = res.status;
    throw err;
  }
  return payload;
}

export async function getSystemInfo() {
  const res = await fetch('/api/system');
  if (!res.ok) throw new Error(`system info failed: HTTP ${res.status}`);
  return res.json();
}

export async function rebuildBinaries() {
  return postJson('/api/build', {});
}

/**
 * Runs one implementation on one graph.
 *
 * graph: { nodeIds: number[], edges: [u, v][] }
 * Returns the raw JSON object the C program printed, plus `executedBy`
 * provenance and the original nodeIds.
 */
export async function runPageRank({
  implementation, graph, generate, params, threads, history = true, repeat = 1,
}, opts) {
  const payload = await postJson('/api/pagerank/run', {
    implementation,
    graph: generate ? undefined : { nodeIds: graph.nodeIds, edges: graph.edges },
    generate,
    params,
    threads,
    history,
    repeat,
  }, opts);
  return { ...payload.result, graphInfo: payload.graphInfo };
}

/** Serial vs OpenMP across a ladder of thread counts, all measured live. */
export async function comparePageRank({
  graph, generate, params, threadCounts, repeat = 3,
}, opts) {
  return postJson('/api/pagerank/compare', {
    graph: generate ? undefined : { nodeIds: graph.nodeIds, edges: graph.edges },
    generate,
    params,
    threadCounts,
    repeat,
  }, opts);
}
