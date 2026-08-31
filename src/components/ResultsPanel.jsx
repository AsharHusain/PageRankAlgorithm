import React, { useMemo, useState } from 'react';
import { THREAD_COLORS } from './GraphCanvas.jsx';
import { referenceCrossCheck } from '../reference/pagerankReference.js';

// Presents the JSON object the C program returned. Every figure below is
// read straight out of that response -- this component computes only
// presentational things (sorting for the ranking table, percentages).

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`stat${tone ? ` stat-${tone}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value mono">{value}</div>
      {sub && <div className="stat-sub mono">{sub}</div>}
    </div>
  );
}

function formatMs(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(1)} µs`;
  if (ms < 1000) return `${ms.toFixed(3)} ms`;
  return `${(ms / 1000).toFixed(3)} s`;
}

export default function ResultsPanel({ result, graph }) {
  const [showProvenance, setShowProvenance] = useState(false);
  const [crossCheck, setCrossCheck] = useState(null);

  const nodeIds = result.nodeIds || result.pagerank.map((_, i) => i);

  const ranked = useMemo(
    () => result.pagerank
      .map((pr, i) => ({ id: nodeIds[i], pr }))
      .sort((a, b) => b.pr - a.pr),
    [result, nodeIds],
  );

  const isOpenmp = result.implementation === 'openmp';

  function runCrossCheck() {
    // Explicitly user-initiated. Runs an independent JavaScript power
    // iteration and reports how far it lands from the C answer. It is a
    // validator, never a substitute -- the numbers on screen stay C's.
    setCrossCheck(referenceCrossCheck(graph, result));
  }

  return (
    <div className="results">
      <div className="card">
        <div className="card-head">
          <h3>Execution</h3>
          <span className={`badge ${isOpenmp ? 'badge-amber' : 'badge-teal'}`}>
            {isOpenmp ? 'OpenMP C' : 'Serial C'}
          </span>
        </div>

        <div className="statgrid">
          <Stat label="Implementation" value={isOpenmp ? 'openmp_pagerank' : 'serial_pagerank'}
                sub={isOpenmp ? 'gcc -O2 -fopenmp' : 'gcc -O2'} />
          {isOpenmp && (
            <Stat
              label="Threads used"
              value={result.threads_used}
              sub={result.threads_requested !== result.threads_used
                ? `requested ${result.threads_requested} · ${result.max_threads_available} available`
                : `of ${result.max_threads_available} available`}
              tone={result.threads_requested !== result.threads_used ? 'warn' : undefined}
            />
          )}
          <Stat label="Iterations" value={result.iterations} sub={`cap ${result.max_iterations}`} />
          <Stat
            label="Converged"
            value={result.converged ? 'Yes' : 'No'}
            sub={result.converged ? `below tol ${result.tolerance.toExponential(0)}` : 'hit the iteration cap'}
            tone={result.converged ? 'ok' : 'warn'}
          />
          <Stat label="Final L1 difference"
                value={result.final_difference?.toExponential(3) ?? '—'} />
          <Stat label="Execution time" value={formatMs(result.timing_ms)}
                sub={result.timing_runs > 1 ? `fastest of ${result.timing_runs} runs` : 'single run'} />
          <Stat label="Rank sum" value={result.rank_sum?.toFixed(9)}
                sub="should be 1.000000000"
                tone={Math.abs(result.rank_sum - 1) < 1e-6 ? 'ok' : 'warn'} />
          <Stat label="Graph" value={`${result.nodes} nodes · ${result.edges} edges`}
                sub={`${result.dangling_nodes} dangling`} />
        </div>

        <button className="linkbtn mono small" type="button"
                onClick={() => setShowProvenance((v) => !v)}>
          {showProvenance ? '▾' : '▸'} where did these numbers come from?
        </button>
        {showProvenance && (
          <pre className="provenance mono small">
{`host    : ${result.executedBy.host}
binary  : ${result.executedBy.binary}
argv    : ${result.executedBy.argv.join(' ')}
stdin   : ${result.nodes} nodes, ${result.edges} edges
round-trip incl. process startup: ${result.executedBy.wallMsIncludingProcessStartup} ms`}
          </pre>
        )}
      </div>

      {isOpenmp && result.thread_work?.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Thread work distribution</h3>
            <span className="tag mono">measured, not simulated</span>
          </div>
          <p className="muted small">
            Which nodes <code>schedule(static)</code> actually handed to each thread, read back
            from <code>omp_get_thread_num()</code> inside the same parallel-for the solver uses.
            Measured outside the timed region so it cannot distort the timing above.
          </p>
          <div className="workbars">
            {result.thread_work.map((t) => {
              const maxNodes = Math.max(...result.thread_work.map((x) => x.nodes)) || 1;
              return (
                <div className="workbar" key={t.thread}>
                  <span className="workbar-label mono small">
                    <span className="thread-dot" style={{ background: THREAD_COLORS[t.thread % THREAD_COLORS.length] }} />
                    T{t.thread}
                  </span>
                  <div className="workbar-track">
                    <div
                      className="workbar-fill"
                      style={{
                        width: `${(t.nodes / maxNodes) * 100}%`,
                        background: THREAD_COLORS[t.thread % THREAD_COLORS.length],
                      }}
                    />
                  </div>
                  <span className="workbar-value mono small">
                    {t.nodes} nodes · {t.in_edges} in-edges
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>PageRank results</h3>
          <span className="tag mono">returned by C</span>
        </div>
        <div className="tablescroll">
          <table className="datatable">
            <thead>
              <tr><th>Rank</th><th>Node</th><th>PageRank</th><th>Share</th></tr>
            </thead>
            <tbody>
              {ranked.map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>{r.id}</td>
                  <td>{r.pr.toFixed(8)}</td>
                  <td>
                    <div className="sharebar">
                      <div className="sharebar-fill" style={{ width: `${r.pr * 100}%` }} />
                      <span>{(r.pr * 100).toFixed(2)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Independent cross-check</h3>
          <span className="tag mono">optional</span>
        </div>
        <p className="muted small">
          Runs a <b>reference JavaScript implementation</b> of the same recurrence on this graph and
          reports how far it lands from the C answer. This is a validator only — the values shown
          everywhere else in this app come from C, and nothing here replaces them.
        </p>
        <div className="btnrow" style={{ marginTop: 10 }}>
          <button className="btn small" type="button" onClick={runCrossCheck} disabled={!graph}>
            Compare against the JS reference
          </button>
        </div>
        {crossCheck && (
          <p className="mono small" style={{ marginTop: 10 }}>
            max |PR<sub>C</sub> − PR<sub>JS</sub>| = <b>{crossCheck.maxAbsDiff.toExponential(3)}</b>
            {' · '}JS iterations: {crossCheck.iterations} (C: {result.iterations})
            {' · '}
            <span className={crossCheck.maxAbsDiff < 1e-9 ? 'okish' : 'warnish'}>
              {crossCheck.maxAbsDiff < 1e-9 ? 'agreement confirmed' : 'divergence — investigate'}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}
