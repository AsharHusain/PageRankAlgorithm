import React, { useEffect, useState } from 'react';
import OverviewTab from './components/OverviewTab.jsx';
import LabTab from './components/LabTab.jsx';
import BenchmarkTab from './components/BenchmarkTab.jsx';
import CodeTab from './components/CodeTab.jsx';
import ArchiveTab from './components/ArchiveTab.jsx';
import { getSystemInfo } from './api/client.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'lab', label: 'Lab' },
  { id: 'benchmark', label: 'Benchmark' },
  { id: 'code', label: 'Code' },
  { id: 'archive', label: 'Archive' },
];

export default function App() {
  const [active, setActive] = useState('overview');
  const [system, setSystem] = useState(null);
  const [systemError, setSystemError] = useState(null);

  // One probe at startup tells every tab what this machine can do, and
  // surfaces a missing compiler immediately instead of at first Run.
  useEffect(() => {
    getSystemInfo().then(setSystem).catch((e) => setSystemError(e.message));
  }, []);

  const backendOk = system?.gccAvailable && system?.binaries?.serial?.compiled;

  return (
    <div className="app">
      <nav className="topnav">
        <div className="wrap navwrap">
          <div className="brand"><span className="dot" /> PageRank Lab</div>
          <div className="navlinks">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`navlink${active === t.id ? ' active' : ''}`}
                onClick={() => setActive(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="navstatus mono small" title={system ? `${system.gcc} on ${system.hostname}` : ''}>
            <span className={`statusdot ${backendOk ? 'ok' : system ? 'bad' : 'pending'}`} />
            {system
              ? backendOk
                ? `C backend · ${system.ompMaxThreads ?? '?'} threads`
                : 'C backend unavailable'
              : systemError ? 'backend unreachable' : 'connecting…'}
          </div>
        </div>
      </nav>

      {systemError && (
        <div className="wrap">
          <div className="callout callout-error" style={{ marginTop: 20 }}>
            <b>Cannot reach the PageRank API.</b> {systemError}
            <br />Start it with <code>npm run dev</code> (the API is mounted inside the Vite server).
          </div>
        </div>
      )}

      <main className="wrap">
        {active === 'overview' && <OverviewTab system={system} onOpenLab={() => setActive('lab')} />}
        {active === 'lab' && <LabTab system={system} />}
        {active === 'benchmark' && <BenchmarkTab system={system} />}
        {active === 'code' && <CodeTab />}
        {active === 'archive' && <ArchiveTab />}
      </main>

      <footer className="wrap">
        <span>CSS 311 — Parallel &amp; Distributed Computing · Assignment I</span>
        <span>React UI · Node API · <b>PageRank computed in C</b></span>
      </footer>
    </div>
  );
}
