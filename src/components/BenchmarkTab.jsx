import React, { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { comparePageRank } from '../api/client.js';
import { loadDemoGraph } from '../data/graphModel.js';

// Serial vs OpenMP, measured live on this machine.
//
// Every time in this tab comes from a wall-clock measurement inside the C
// binary that just ran. Speed-up and efficiency are computed from those
// two measurements and nothing else:
//     speedup    = serial_time / parallel_time
//     efficiency = speedup / threads_used

const SIZES = [
  { id: 'small', label: 'small', nodes: 1000, degree: 6 },
  { id: 'medium', label: 'medium', nodes: 10000, degree: 6 },
  { id: 'large', label: 'large', nodes: 100000, degree: 6 },
  { id: 'xlarge', label: 'x-large', nodes: 500000, degree: 6 },
];

export default function BenchmarkTab({ system }) {
  const [source, setSource] = useState('generated');
  const [sizeId, setSizeId] = useState('large');
  const [repeat, setRepeat] = useState(5);
  const [status, setStatus] = useState('idle');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState('');

  const maxThreads = system?.ompMaxThreads || system?.cpus || 8;
  const defaultLadder = useMemo(() => {
    const s = new Set([1]);
    for (let t = 2; t <= maxThreads; t *= 2) s.add(t);
    s.add(maxThreads);
    return [...s].sort((a, b) => a - b).slice(0, 8);
  }, [maxThreads]);
  const [ladder, setLadder] = useState(null);
  const threadCounts = ladder ?? defaultLadder;

  const size = SIZES.find((s) => s.id === sizeId);

  async function run() {
    setStatus('running');
    setError(null);
    setProgress(`Compiling if needed, then running serial + ${threadCounts.length} OpenMP configurations…`);
    try {
      const body = source === 'generated'
        ? { generate: { nodes: size.nodes, degree: size.degree, seed: 42 } }
        : { graph: loadDemoGraph() };
      const res = await comparePageRank({
        ...body,
        params: { damping: 0.85, tolerance: 1e-6, maxIterations: 100 },
        threadCounts,
        repeat,
      });
      setData(res);
      setStatus('done');
    } catch (err) {
      setError(err);
      setStatus('error');
    } finally {
      setProgress('');
    }
  }

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.openmp.map((o) => ({
      threads: o.threadsUsed,
      speedup: o.speedup,
      ideal: o.threadsUsed,
      efficiency: o.efficiency * 100,
      timeMs: o.timingMs,
    }));
  }, [data]);

  const best = useMemo(() => {
    if (!data?.openmp.length) return null;
    return data.openmp.reduce((a, b) => (b.speedup > a.speedup ? b : a));
  }, [data]);

  return (
    <div className="tabpanel">
      <div className="sec-head wide">
        <span className="sec-num">Benchmark</span>
        <h2>Serial vs OpenMP — measured on this machine, right now</h2>
        <p className="sec-sub">
          Runs <code>serial_pagerank</code> once and <code>openmp_pagerank</code> once per thread
          count, on the same graph with the same parameters, and reports the wall times they
          measured. Nothing here is read from a saved file.
        </p>
      </div>

      <div className="card">
        <div className="benchcontrols">
          <div className="field">
            <span className="field-label">Graph</span>
            <div className="segmented">
              <button type="button" className={source === 'generated' ? 'active' : ''}
                      onClick={() => setSource('generated')} disabled={status === 'running'}>
                Generated
              </button>
              <button type="button" className={source === 'demo' ? 'active' : ''}
                      onClick={() => setSource('demo')} disabled={status === 'running'}>
                Demo (N=6)
              </button>
            </div>
            <span className="field-hint">
              {source === 'generated'
                ? 'Built inside the C program from a fixed seed, so every run uses the identical graph.'
                : 'The 6-node graph is far too small to parallelise — useful for showing overhead dominating.'}
            </span>
          </div>

          {source === 'generated' && (
            <label className="field">
              <span className="field-label">Size</span>
              <select value={sizeId} onChange={(e) => setSizeId(e.target.value)}
                      disabled={status === 'running'}>
                {SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} — N = {s.nodes.toLocaleString()}, avg out-deg {s.degree}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field">
            <span className="field-label">Runs per configuration</span>
            <select value={repeat} onChange={(e) => setRepeat(+e.target.value)}
                    disabled={status === 'running'}>
              {[1, 3, 5, 10, 25].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <span className="field-hint">Fastest wall time of N is reported.</span>
          </label>

          <div className="field">
            <span className="field-label">Thread counts</span>
            <div className="chipset">
              {defaultLadder.map((t) => {
                const on = threadCounts.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    className={`chipbtn${on ? ' active' : ''}`}
                    disabled={status === 'running'}
                    onClick={() => {
                      const next = on ? threadCounts.filter((x) => x !== t) : [...threadCounts, t].sort((a, b) => a - b);
                      setLadder(next.length ? next : [1]);
                    }}
                  >{t}</button>
                );
              })}
            </div>
            <span className="field-hint mono">
              {system?.ompMaxThreads ?? '?'} threads / {system?.cpus ?? '?'} CPUs available
            </span>
          </div>

          <button className="btn primary run-btn" type="button" onClick={run}
                  disabled={status === 'running'}>
            {status === 'running' ? 'Measuring…' : 'Run benchmark'}
          </button>
        </div>

        {status === 'running' && (
          <div className="runstate runstate-running">
            <span><span className="spinner" />{progress}</span>
          </div>
        )}
        {status === 'error' && (
          <div className="runstate runstate-error"><span>✕ {error?.message}</span></div>
        )}
      </div>

      {data && (
        <>
          <div className="statgrid cards-row" style={{ marginTop: 16 }}>
            <div className="stat">
              <div className="stat-label">Graph</div>
              <div className="stat-value mono">{data.graphInfo.nodes?.toLocaleString()} nodes</div>
              <div className="stat-sub mono">{data.graphInfo.edges?.toLocaleString()} edges</div>
            </div>
            <div className="stat">
              <div className="stat-label">Serial baseline</div>
              <div className="stat-value mono">{data.serial.timingMs.toFixed(3)} ms</div>
              <div className="stat-sub mono">{data.serial.iterations} iterations</div>
            </div>
            <div className="stat stat-ok">
              <div className="stat-label">Best speed-up</div>
              <div className="stat-value mono">{best ? `${best.speedup.toFixed(2)}×` : '—'}</div>
              <div className="stat-sub mono">at {best?.threadsUsed} threads</div>
            </div>
            <div className="stat">
              <div className="stat-label">Serial vs OpenMP agreement</div>
              <div className="stat-value mono">
                {data.verification.maxAbsDifferenceSerialVsOpenmp === null
                  ? '—'
                  : data.verification.maxAbsDifferenceSerialVsOpenmp.toExponential(2)}
              </div>
              <div className="stat-sub mono">max |ΔPR|</div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <div className="card-head">
              <h3>Measured results</h3>
              <span className="tag mono">fastest of {data.repeat} runs each</span>
            </div>
            <div className="tablescroll">
              <table className="datatable">
                <thead>
                  <tr>
                    <th>Configuration</th><th>Threads used</th><th>Time (ms)</th>
                    <th>Speedup</th><th>Efficiency</th><th>Iterations</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Serial</td>
                    <td>1</td>
                    <td>{data.serial.timingMs.toFixed(4)}</td>
                    <td>1.00× <span className="muted">(baseline)</span></td>
                    <td>—</td>
                    <td>{data.serial.iterations}</td>
                  </tr>
                  {data.openmp.map((o) => (
                    <tr key={o.threadsRequested}>
                      <td>OpenMP</td>
                      <td>
                        {o.threadsUsed}
                        {o.threadsUsed !== o.threadsRequested && (
                          <span className="warnish"> (asked {o.threadsRequested})</span>
                        )}
                      </td>
                      <td>{o.timingMs.toFixed(4)}</td>
                      <td className={o.speedup >= 1 ? 'okish' : 'warnish'}>{o.speedup.toFixed(2)}×</td>
                      <td>{(o.efficiency * 100).toFixed(1)}%</td>
                      <td>{o.iterations}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              speedup = serial_time / parallel_time · efficiency = speedup / threads_used.
              Both derived entirely from the measured times in this table.
            </p>
          </div>

          <div className="grid2" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>Speed-up vs thread count</h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData}>
                  <CartesianGrid stroke="rgba(159,176,195,0.12)" />
                  <XAxis dataKey="threads" stroke="#8a99ad" tick={{ fontSize: 11 }}
                         label={{ value: 'threads', position: 'insideBottom', offset: -2, fill: '#8a99ad', fontSize: 11 }} />
                  <YAxis stroke="#8a99ad" tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: '#0d1420', border: '1px solid #26364d', borderRadius: 8 }}
                           formatter={(v, n) => [typeof v === 'number' ? v.toFixed(2) : v, n]} />
                  <Legend />
                  <Line type="monotone" dataKey="speedup" name="Measured" stroke="#35bfb0"
                        strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ideal" name="Ideal (linear)" stroke="#eda94a"
                        strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="card">
              <h3>Parallel efficiency</h3>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData}>
                  <CartesianGrid stroke="rgba(159,176,195,0.12)" />
                  <XAxis dataKey="threads" stroke="#8a99ad" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#8a99ad" tick={{ fontSize: 11 }} unit="%" domain={[0, 110]} />
                  <Tooltip contentStyle={{ background: '#0d1420', border: '1px solid #26364d', borderRadius: 8 }}
                           formatter={(v) => [`${v.toFixed(1)}%`, 'efficiency']} />
                  <Line type="monotone" dataKey="efficiency" name="Efficiency" stroke="#7aa2f7"
                        strokeWidth={2} dot={{ r: 4 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="callout" style={{ marginTop: 16 }}>
            <b>Reading these numbers.</b> Speed-up below the ideal line is normal: each power
            iteration ends at an implicit barrier, and PageRank on a sparse graph is
            memory-bandwidth bound, so adding threads stops helping once the memory system
            saturates. On a small graph, thread-team startup can cost more than the arithmetic
            saved — which is why a speed-up under 1× is a real result, not a bug.
          </div>
        </>
      )}
    </div>
  );
}
