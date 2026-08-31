import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GraphEditor from './GraphEditor.jsx';
import GraphCanvas from './GraphCanvas.jsx';
import ResultsPanel from './ResultsPanel.jsx';
import IterationPlayer from './IterationPlayer.jsx';
import { runPageRank } from '../api/client.js';
import { loadDemoGraph, graphSignature, graphStats } from '../data/graphModel.js';

// The lab: build a graph, choose parameters, execute the real C program,
// then explore what it returned.
//
// Invariant for this whole component: `result` is only ever the object a
// C process printed. It is set from the API response and cleared when the
// graph changes underneath it. Nothing in this file computes a rank.

export default function LabTab({ system }) {
  const [graph, setGraph] = useState(() => loadDemoGraph());
  const [implementation, setImplementation] = useState('serial');
  const [threads, setThreads] = useState(4);
  const [params, setParams] = useState({ damping: 0.85, tolerance: 1e-6, maxIterations: 100 });
  const [repeat, setRepeat] = useState(1);

  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [rawResult, setRawResult] = useState(null);
  const [error, setError] = useState(null);
  const [resultSignature, setResultSignature] = useState(null);
  const [cursor, setCursor] = useState(0);
  const [colorByThread, setColorByThread] = useState(false);
  const abortRef = useRef(null);

  const stats = graphStats(graph);
  const signature = graphSignature(graph);

  // Editing the graph invalidates the ranks immediately. Deriving this
  // instead of clearing it in an effect means there is never a frame where
  // stale node sizes are shown as if they still described the graph.
  // (The signature ignores node positions, so dragging keeps the result.)
  const result = resultSignature === signature ? rawResult : null;

  const maxThreads = system?.ompMaxThreads || system?.cpus || 8;
  const threadOptions = useMemo(() => {
    const s = new Set([1, 2, 4, 8]);
    for (let t = 2; t <= maxThreads; t *= 2) s.add(t);
    s.add(maxThreads);
    return [...s].filter((t) => t >= 1 && t <= 128).sort((a, b) => a - b);
  }, [maxThreads]);

  // History snapshot currently on screen. Falls back to the final vector
  // when the graph was too large for C to record per-node snapshots.
  const history = result?.iteration_history ?? [];
  const hasVectors = !!result?.history_has_vectors;
  const displayedRanks = useMemo(() => {
    if (!result) return null;
    if (!hasVectors) return result.pagerank;
    const snap = history[Math.min(cursor, history.length - 1)];
    return snap?.pagerank ?? result.pagerank;
  }, [result, history, cursor, hasVectors]);

  const threadOf = useMemo(() => {
    if (!colorByThread) return null;
    if (result?.implementation !== 'openmp') return null;
    return result.node_thread?.length ? result.node_thread : null;
  }, [colorByThread, result]);

  async function execute() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('running');
    setError(null);
    try {
      const res = await runPageRank({
        implementation,
        graph,
        params,
        threads: implementation === 'openmp' ? threads : undefined,
        history: true,
        repeat,
      }, { signal: controller.signal });

      setRawResult(res);
      setResultSignature(signature);
      setCursor((res.iteration_history?.length ?? 1) - 1);
      setStatus('done');
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(err);
      setStatus('error');
    }
  }

  const handleGraphChange = useCallback((next) => {
    setGraph(next);
  }, []);

  // Once the result no longer matches the graph on screen, drop the
  // "Completed" banner too -- it would otherwise describe a vanished result.
  useEffect(() => {
    if (!result && status === 'done') setStatus('idle');
  }, [result, status]);

  const running = status === 'running';
  const tooBig = stats.nodes > 20000 || stats.edges > 200000;

  return (
    <div className="tabpanel">
      <div className="sec-head wide">
        <span className="sec-num">Lab</span>
        <h2>Build a graph, run the real C program on it</h2>
        <p className="sec-sub">
          The graph you draw here is serialised, piped to a{' '}
          <code>gcc</code>-compiled binary on stdin, solved by the C power iteration, and
          returned as JSON. Nothing on this page is computed in the browser.
        </p>
      </div>

      <div className="lab-grid">
        <div className="lab-main">
          <div className="card">
            <div className="card-head">
              <h3>Graph editor</h3>
              <span className="tag mono">input to the C program</span>
            </div>
            <GraphEditor
              graph={graph}
              onChange={handleGraphChange}
              ranks={displayedRanks}
              threadOf={threadOf}
              disabled={running}
            />
          </div>

          {result && (
            <>
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-head">
                  <h3>
                    {hasVectors
                      ? `PageRank at iteration ${history[Math.min(cursor, history.length - 1)]?.iteration ?? 0}`
                      : 'Converged PageRank'}
                  </h3>
                  <div className="btnrow">
                    {result.implementation === 'openmp' && result.node_thread?.length > 0 && (
                      <button
                        className={`btn small${colorByThread ? ' primary' : ''}`}
                        type="button"
                        onClick={() => setColorByThread((v) => !v)}
                      >
                        {colorByThread ? 'Colour by rank' : 'Colour by thread'}
                      </button>
                    )}
                  </div>
                </div>
                {colorByThread && (
                  <p className="muted small" style={{ marginBottom: 8 }}>
                    Node colour shows the thread that <code>schedule(static)</code> assigned it —
                    reported by the OpenMP runtime itself. Size still encodes the PageRank value.
                  </p>
                )}
                <GraphCanvas
                  graph={graph}
                  ranks={displayedRanks}
                  threadOf={threadOf}
                  showRankLabels
                />
              </div>

              {history.length > 1 && (
                <div style={{ marginTop: 16 }}>
                  <IterationPlayer
                    history={history}
                    hasVectors={hasVectors}
                    nodeIds={result.nodeIds}
                    cursor={cursor}
                    onCursor={setCursor}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <aside className="lab-side">
          <div className="card">
            <div className="card-head"><h3>Execution</h3></div>

            <div className="field">
              <span className="field-label">Implementation</span>
              <div className="segmented">
                <button
                  type="button"
                  className={implementation === 'serial' ? 'active' : ''}
                  onClick={() => setImplementation('serial')}
                  disabled={running}
                >Serial</button>
                <button
                  type="button"
                  className={implementation === 'openmp' ? 'active' : ''}
                  onClick={() => setImplementation('openmp')}
                  disabled={running}
                >OpenMP</button>
              </div>
              <span className="field-hint mono">
                {implementation === 'serial'
                  ? 'c/serial_pagerank.c · gcc -O2'
                  : 'c/openmp_pagerank.c · gcc -O2 -fopenmp'}
              </span>
            </div>

            {implementation === 'openmp' && (
              <label className="field">
                <span className="field-label">Threads</span>
                <select value={threads} onChange={(e) => setThreads(+e.target.value)} disabled={running}>
                  {threadOptions.map((t) => (
                    <option key={t} value={t}>{t}{t === maxThreads ? ' (all cores)' : ''}</option>
                  ))}
                </select>
                <span className="field-hint mono">
                  {system?.ompMaxThreads ?? '?'} available on this machine
                </span>
              </label>
            )}

            <label className="field">
              <span className="field-label">Damping factor (d)</span>
              <input type="number" step="0.05" min="0" max="0.99" value={params.damping}
                     disabled={running}
                     onChange={(e) => setParams((p) => ({ ...p, damping: +e.target.value }))} />
              <span className="field-hint">Probability the surfer follows a link. 0 ≤ d &lt; 1.</span>
            </label>

            <label className="field">
              <span className="field-label">Tolerance (ε)</span>
              <select value={params.tolerance} disabled={running}
                      onChange={(e) => setParams((p) => ({ ...p, tolerance: +e.target.value }))}>
                {[1e-3, 1e-4, 1e-6, 1e-8, 1e-10].map((t) => (
                  <option key={t} value={t}>{t.toExponential(0)}</option>
                ))}
              </select>
              <span className="field-hint">Stop when the L1 change drops below this.</span>
            </label>

            <label className="field">
              <span className="field-label">Max iterations</span>
              <input type="number" step="1" min="1" max="10000" value={params.maxIterations}
                     disabled={running}
                     onChange={(e) => setParams((p) => ({ ...p, maxIterations: +e.target.value }))} />
            </label>

            <label className="field">
              <span className="field-label">Timing runs</span>
              <select value={repeat} onChange={(e) => setRepeat(+e.target.value)} disabled={running}>
                {[1, 3, 5, 10, 25].map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              <span className="field-hint">
                Solve this many times and report the fastest wall time. Higher = less noise.
              </span>
            </label>

            <button
              className="btn primary run-btn"
              type="button"
              onClick={execute}
              disabled={running || stats.nodes === 0 || tooBig}
            >
              {running ? 'Running…' : `Run ${implementation === 'serial' ? 'Serial' : 'OpenMP'} C`}
            </button>

            {stats.nodes === 0 && (
              <p className="field-hint" style={{ marginTop: 8 }}>Add at least one node first.</p>
            )}
            {tooBig && (
              <p className="warnish small" style={{ marginTop: 8 }}>
                Graph exceeds the interactive limit (20 000 nodes / 200 000 edges).
              </p>
            )}

            <div className={`runstate runstate-${status}`}>
              {status === 'idle' && <span>Ready.</span>}
              {running && (
                <span>
                  <span className="spinner" />
                  Running {implementation === 'openmp'
                    ? `OpenMP C implementation — ${threads} threads`
                    : 'Serial C implementation'}…
                </span>
              )}
              {status === 'done' && result && (
                <span>
                  ✓ Completed — results generated by{' '}
                  <b>{result.implementation === 'openmp' ? 'OpenMP C' : 'Serial C'}</b>
                  {result.implementation === 'openmp' && <> on {result.threads_used} threads</>}
                  {' '}in {result.timing_ms < 1
                    ? `${(result.timing_ms * 1000).toFixed(1)} µs`
                    : `${result.timing_ms.toFixed(3)} ms`}
                </span>
              )}
              {status === 'error' && (
                <span>✕ {error?.message}</span>
              )}
            </div>

            {status === 'error' && error?.detail && (
              <pre className="errordetail mono small">{error.detail}</pre>
            )}
          </div>

          {result && <ResultsPanel result={result} graph={graph} />}
        </aside>
      </div>
    </div>
  );
}
