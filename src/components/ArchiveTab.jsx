import React, { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import serialOutput from '../generated/serialOutput.js';
import openmpOutput from '../generated/openmpOutput.js';
import { parseSizeTable, parseThreadTable, parseMaxThreads } from '../data/parseOutputs.js';

// HISTORICAL DATA ONLY.
//
// This tab shows outputs/*.txt -- the terminal capture from the original
// assignment run, on a machine that exposed a single logical core. It is
// kept because the printed submission references those figures.
//
// It is deliberately NOT the live benchmark. Live numbers live in the
// Benchmark tab and are measured on demand. Everything here is labelled
// as archived so the two can never be confused.

export default function ArchiveTab() {
  const serialSizes = useMemo(() => parseSizeTable(serialOutput), []);
  const openmpSizes = useMemo(() => parseSizeTable(openmpOutput), []);
  const threadRows = useMemo(() => parseThreadTable(openmpOutput), []);
  const maxThreads = useMemo(() => parseMaxThreads(openmpOutput), []);

  const merged = serialSizes.map((s) => {
    const o = openmpSizes.find((x) => x.size === s.size) || {};
    const speedup = o.time ? s.time / o.time : null;
    return { size: s.size, N: s.N, E: s.E, serialTime: s.time, openmpTime: o.time, speedup };
  });

  return (
    <div className="tabpanel">
      <div className="sec-head wide">
        <span className="sec-num">Archive</span>
        <h2>Captured lab output from the original submission</h2>
        <p className="sec-sub">
          Parsed from <code>outputs/serial_output.txt</code> and <code>outputs/openmp_output.txt</code>,
          which were recorded once, by hand, on the machine used for the assignment.
        </p>
      </div>

      <div className="callout callout-strong">
        <b>These are historical numbers, not live measurements.</b> They were captured on a machine
        that reported <b>{maxThreads}</b> hardware thread{maxThreads === 1 ? '' : 's'}, which is why
        the OpenMP speed-up below sits at or under 1× — with one core there is nowhere for a second
        thread to run. For times measured on the machine you are using right now, open the{' '}
        <b>Benchmark</b> tab.
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Runtime by input size (OpenMP at 4 threads)</h3>
          <span className="tag mono">archived</span>
        </div>
        <div className="tablescroll">
          <table className="datatable">
            <thead>
              <tr><th>Size</th><th>N</th><th>E</th><th>Serial (s)</th><th>OpenMP (s)</th><th>Speedup</th></tr>
            </thead>
            <tbody>
              {merged.map((r) => (
                <tr key={r.size}>
                  <td>{r.size}</td><td>{r.N}</td><td>{r.E}</td>
                  <td>{r.serialTime?.toFixed(6)}</td>
                  <td>{r.openmpTime?.toFixed(6)}</td>
                  <td>{r.speedup ? `${r.speedup.toFixed(2)}×` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={merged}>
            <CartesianGrid stroke="rgba(159,176,195,0.12)" />
            <XAxis dataKey="N" stroke="#8a99ad" tick={{ fontSize: 11 }} />
            <YAxis stroke="#8a99ad" tick={{ fontSize: 11 }}
                   label={{ value: 'seconds', angle: -90, position: 'insideLeft', fill: '#8a99ad', fontSize: 11 }} />
            <Tooltip contentStyle={{ background: '#0d1420', border: '1px solid #26364d', borderRadius: 8 }} />
            <Legend />
            <Line type="monotone" dataKey="serialTime" name="Serial" stroke="#35bfb0" strokeWidth={2} dot={{ r: 4 }} />
            <Line type="monotone" dataKey="openmpTime" name="OpenMP (4 threads)" stroke="#eda94a" strokeWidth={2} dot={{ r: 4 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Speed-up vs thread count (N = 100 000)</h3>
          <span className="tag mono">archived · single-core machine</span>
        </div>
        <div className="tablescroll">
          <table className="datatable">
            <thead><tr><th>Threads</th><th>Time (s)</th><th>Speedup</th></tr></thead>
            <tbody>
              {threadRows.map((r) => (
                <tr key={r.threads}>
                  <td>{r.threads}</td><td>{r.time.toFixed(6)}</td><td>{r.speedup.toFixed(2)}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h3>Raw captured output</h3>
          <span className="tag mono">verbatim</span>
        </div>
        <div className="grid2" style={{ marginTop: 0 }}>
          <pre className="code-block">{serialOutput}</pre>
          <pre className="code-block">{openmpOutput}</pre>
        </div>
      </div>
    </div>
  );
}
