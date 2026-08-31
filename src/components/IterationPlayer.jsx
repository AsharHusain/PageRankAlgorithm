import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';

// Steps through the iteration history that the C program recorded.
//
// This component performs NO arithmetic on PageRank values. Every vector
// it displays was produced by a power iteration inside the C binary and
// shipped over the wire; the player only picks which recorded snapshot to
// show. That is the whole reason the C program records history at all.

export default function IterationPlayer({ history, hasVectors, nodeIds, cursor, onCursor }) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(400);
  const timer = useRef(null);

  const last = history.length - 1;

  useEffect(() => {
    if (!playing) return undefined;
    timer.current = setInterval(() => {
      onCursor((c) => {
        if (c >= last) { setPlaying(false); return last; }
        return c + 1;
      });
    }, speed);
    return () => clearInterval(timer.current);
  }, [playing, speed, last, onCursor]);

  // Stop playback if the history is replaced by a new run.
  useEffect(() => { setPlaying(false); }, [history]);

  const chartData = useMemo(
    () => history
      .filter((h) => h.difference !== null && h.difference !== undefined)
      .map((h) => ({ iteration: h.iteration, difference: h.difference })),
    [history],
  );

  const current = history[Math.min(cursor, last)] ?? history[0];
  const atEnd = cursor >= last;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Convergence — replayed from the C run</h3>
        <span className="tag mono">{history.length} recorded iterations</span>
      </div>

      <div className="player">
        <div className="btnrow">
          <button className="btn small" type="button" onClick={() => { setPlaying(false); onCursor(0); }}
                  disabled={cursor === 0}>⏮ Restart</button>
          <button className="btn small" type="button" onClick={() => { setPlaying(false); onCursor((c) => Math.max(0, c - 1)); }}
                  disabled={cursor === 0}>‹ Prev</button>
          <button className="btn primary small" type="button"
                  onClick={() => { if (atEnd) onCursor(0); setPlaying((p) => !p); }}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="btn small" type="button" onClick={() => { setPlaying(false); onCursor((c) => Math.min(last, c + 1)); }}
                  disabled={atEnd}>Next ›</button>
        </div>
        <label className="inline-label mono small">
          speed
          <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
            <option value={800}>0.5×</option>
            <option value={400}>1×</option>
            <option value={200}>2×</option>
            <option value={80}>5×</option>
          </select>
        </label>
      </div>

      <input
        className="scrubber"
        type="range"
        min={0}
        max={last}
        value={Math.min(cursor, last)}
        onChange={(e) => { setPlaying(false); onCursor(+e.target.value); }}
        aria-label="Iteration"
      />

      <div className="player-readout mono">
        <span>iteration <b>{current.iteration}</b> / {last}</span>
        <span>
          L1 difference{' '}
          <b>{current.difference === null || current.difference === undefined
            ? '—'
            : current.difference.toExponential(4)}</b>
        </span>
        {!hasVectors && (
          <span className="warnish">
            per-node vectors not recorded for a graph this large — differences only
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="rgba(159,176,195,0.12)" />
          <XAxis dataKey="iteration" stroke="#8a99ad" tick={{ fontSize: 11 }}
                 label={{ value: 'iteration', position: 'insideBottom', offset: -2, fill: '#8a99ad', fontSize: 11 }} />
          <YAxis scale="log" domain={['auto', 'auto']} stroke="#8a99ad" tick={{ fontSize: 11 }}
                 tickFormatter={(v) => v.toExponential(0)} width={62} />
          <Tooltip
            contentStyle={{ background: '#0d1420', border: '1px solid #26364d', borderRadius: 8 }}
            formatter={(v) => [v.toExponential(4), 'L1 difference']}
          />
          <ReferenceLine x={current.iteration} stroke="#eda94a" strokeDasharray="4 3" />
          <Line type="monotone" dataKey="difference" stroke="#35bfb0" strokeWidth={2}
                dot={{ r: 2.5 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      {hasVectors && current.pagerank && (
        <table className="datatable">
          <thead>
            <tr><th>Node</th><th>PageRank at iteration {current.iteration}</th></tr>
          </thead>
          <tbody>
            {current.pagerank.map((v, i) => (
              <tr key={i}>
                <td>{nodeIds ? nodeIds[i] : i}</td>
                <td>{v.toFixed(8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
