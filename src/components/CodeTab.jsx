import React, { useState } from 'react';
import serialCode from '../generated/serialCode.js';
import openmpCode from '../generated/openmpCode.js';
import serialOutput from '../generated/serialOutput.js';
import openmpOutput from '../generated/openmpOutput.js';

// Shows the exact .c sources that the backend compiles and runs.
//
// These strings are synced verbatim from c/*.c by scripts/sync-assets.mjs
// on every install/dev/build, so what you read here is what gcc compiled.

const KEYWORDS = /\b(int|long|double|char|void|unsigned|size_t|for|while|do|if|else|return|struct|typedef|include|define|sizeof|const|static|break|continue|switch|case|malloc|calloc|free|main)\b/g;

function highlight(code) {
  let s = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>');
  s = s.replace(/^(\s*\/\/.*)$/gm, '<span class="tok-comment">$1</span>');
  s = s.replace(/^(\s*#.*)$/gm, '<span class="tok-pragma">$1</span>');
  s = s.replace(/("(?:[^"\\]|\\.)*")/g, '<span class="tok-string">$1</span>');
  s = s.replace(KEYWORDS, '<span class="tok-keyword">$&</span>');
  return s;
}

const FILES = {
  serial: {
    file: 'c/serial_pagerank.c',
    code: serialCode,
    output: serialOutput,
    compile: 'gcc -O2 -Wall -o bin/serial_pagerank c/serial_pagerank.c -lm',
    invoke: "printf '6 8\\n0 1\\n0 2\\n1 2\\n2 0\\n3 0\\n3 2\\n4 3\\n4 5\\n' | ./bin/serial_pagerank --json",
  },
  openmp: {
    file: 'c/openmp_pagerank.c',
    code: openmpCode,
    output: openmpOutput,
    compile: 'gcc -O2 -Wall -fopenmp -o bin/openmp_pagerank c/openmp_pagerank.c -lm',
    invoke: "printf '6 8\\n0 1\\n0 2\\n1 2\\n2 0\\n3 0\\n3 2\\n4 3\\n4 5\\n' | ./bin/openmp_pagerank --json --threads 4",
  },
};

function CodePanel({ spec }) {
  const [view, setView] = useState('code');
  const [copied, setCopied] = useState(null);

  function copy(text, what) {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    });
  }

  return (
    <div className="code-panel">
      <div className="code-bar">
        <span className="mono small">{spec.compile}</span>
        <div className="btnrow">
          <button className="btn small" onClick={() => copy(spec.compile, 'cmd')}>
            {copied === 'cmd' ? 'Copied' : 'Copy command'}
          </button>
          <button className="btn small" onClick={() => copy(spec.code, 'code')}>
            {copied === 'code' ? 'Copied' : 'Copy source'}
          </button>
        </div>
      </div>

      <div className="code-bar code-bar-sub">
        <span className="mono small dim">{spec.invoke}</span>
        <div className="btnrow">
          <button className={`btn small${view === 'code' ? ' primary' : ''}`} onClick={() => setView('code')}>Source</button>
          <button className={`btn small${view === 'output' ? ' primary' : ''}`} onClick={() => setView('output')}>Archived output</button>
        </div>
      </div>

      {view === 'output' ? (
        <>
          <div className="inline-note small">
            Historical terminal capture from <code>outputs/</code>. Live results come from the Lab
            and Benchmark tabs.
          </div>
          <pre className="code-block"><code>{spec.output}</code></pre>
        </>
      ) : (
        <pre className="code-block"><code dangerouslySetInnerHTML={{ __html: highlight(spec.code) }} /></pre>
      )}
    </div>
  );
}

export default function CodeTab() {
  const [tab, setTab] = useState('serial');
  return (
    <div className="tabpanel">
      <div className="sec-head wide">
        <span className="sec-num">Code</span>
        <h2>The exact source the backend compiles and executes</h2>
        <p className="sec-sub">
          Synced verbatim from <code>c/</code> at build time. When you press Run in the Lab, the
          server compiles <i>this</i> file with the command shown below and pipes your graph to
          the resulting binary on stdin.
        </p>
      </div>
      <div className="tabs">
        <button className={`tab-btn${tab === 'serial' ? ' active' : ''}`} onClick={() => setTab('serial')}>
          serial_pagerank.c
        </button>
        <button className={`tab-btn${tab === 'openmp' ? ' active' : ''}`} onClick={() => setTab('openmp')}>
          openmp_pagerank.c
        </button>
      </div>
      <CodePanel spec={FILES[tab]} />
    </div>
  );
}
