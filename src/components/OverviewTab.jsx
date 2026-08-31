import React from 'react';
import GraphCanvas from './GraphCanvas.jsx';
import { DEMO_GRAPH } from '../data/graphModel.js';

// Landing page. Deliberately shows the demo graph WITHOUT ranks: every
// node is drawn the same size, because nothing has been solved yet. The
// old version of this page sized nodes by a JavaScript-computed PageRank,
// which is exactly the confusion this rewrite removes.

export default function OverviewTab({ system, onOpenLab }) {
  const ok = system?.gccAvailable && system?.binaries?.serial?.compiled;

  return (
    <div className="tabpanel">
      <div className="hero">
        <span className="eyebrow">CSS 311 · Parallel &amp; Distributed Computing · Assignment I</span>
        <h1>Who matters<br /><span className="accent">in the graph?</span></h1>
        <p className="subhead">
          PageRank scores every node by the company it keeps — a link only counts as much as the
          importance of the page casting it. Draw a graph in the Lab and it is solved by a
          real C program compiled on this machine, serial or OpenMP, your choice.
        </p>
        <div className="chips">
          <span className="chip">damping d = <b>0.85</b></span>
          <span className="chip">CSR reverse adjacency · <b>O(V+E)</b> per pass</span>
          <span className="chip">
            {system ? <>machine: <b>{system.cpus}</b> CPUs · <b>{system.ompMaxThreads ?? '?'}</b> OpenMP threads</>
                    : 'checking machine…'}
          </span>
        </div>
        <div className="btnrow" style={{ marginTop: 22 }}>
          <button className="btn primary" type="button" onClick={onOpenLab}>Open the Lab →</button>
        </div>
      </div>

      <div className={`statusbar ${ok ? 'statusbar-ok' : 'statusbar-warn'}`}>
        {system ? (
          ok ? (
            <>
              <b>Backend ready.</b> {system.gcc} · both C programs compiled ·
              OpenMP reports {system.ompMaxThreads} threads on {system.hostname}.
            </>
          ) : (
            <>
              <b>Backend not ready.</b>{' '}
              {system.gccAvailable
                ? 'The C programs have not been compiled yet — run `npm run build:c`.'
                : 'gcc was not found on PATH. Install build-essential, then restart the dev server.'}
            </>
          )
        ) : 'Contacting the backend…'}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-head">
          <h3>The demonstration graph</h3>
          <span className="tag mono">unsolved — all nodes drawn equal</span>
        </div>
        <GraphCanvas graph={DEMO_GRAPH} ranks={null} showRankLabels={false} height={520} />
        <p className="muted small" style={{ marginTop: 8 }}>
          N = 6, E = 8. Node 5 is a <b>dangling node</b> (no out-links), so its rank mass is
          redistributed evenly across all nodes on every iteration. Load it in the Lab and press
          Run to see what the C program makes of it.
        </p>
      </div>

      <div className="cards3" style={{ marginTop: 20 }}>
        <div className="card">
          <h3>WHAT</h3>
          <p>A "random surfer" follows outgoing links with probability d and jumps to a random page
            with probability (1−d). PageRank is the long-run probability of finding the surfer
            at each node.</p>
          <div className="formula">PR(v) = (1−d)/N + d·Σ<sub>u→v</sub> PR(u)/outdeg(u)</div>
        </div>
        <div className="card">
          <h3>WHY PARALLELISE</h3>
          <p>Within one iteration every node's new score depends only on the <i>previous</i>
            iteration's vector, so all N updates are independent — a textbook
            <code> #pragma omp parallel for</code>. The iterations themselves are strictly
            sequential.</p>
        </div>
        <div className="card">
          <h3>WHERE IT RUNS</h3>
          <p>Your graph is piped to a compiled binary over stdin; the binary prints JSON to stdout.
            The browser draws that JSON. No PageRank arithmetic happens in JavaScript.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>The tabs</h3>
        <ul className="tight-list">
          <li><b>Lab</b> — draw a graph, set parameters, execute the real serial or OpenMP C
            binary, and step through the convergence it recorded.</li>
          <li><b>Benchmark</b> — run serial and OpenMP across a ladder of thread counts and read
            the speed-up and efficiency measured just now on this machine.</li>
          <li><b>Code</b> — the exact <code>.c</code> sources that get compiled and executed.</li>
          <li><b>Archive</b> — the captured single-core lab outputs from the original submission,
            kept for reference and clearly marked as historical.</li>
        </ul>
      </div>
    </div>
  );
}
