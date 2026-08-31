// Server-side render smoke test.
//
// Renders every screen with a REAL response fetched from the running API,
// so a prop-shape mismatch or a crash in a render path fails here instead
// of silently in someone's browser. Run the dev server first, then:
//
//     npm run smoke
//
// This is not a substitute for clicking around, but it catches the class
// of bug that would otherwise show up as a blank page.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import OverviewTab from '../src/components/OverviewTab.jsx';
import LabTab from '../src/components/LabTab.jsx';
import BenchmarkTab from '../src/components/BenchmarkTab.jsx';
import CodeTab from '../src/components/CodeTab.jsx';
import ArchiveTab from '../src/components/ArchiveTab.jsx';
import ResultsPanel from '../src/components/ResultsPanel.jsx';
import IterationPlayer from '../src/components/IterationPlayer.jsx';
import GraphCanvas from '../src/components/GraphCanvas.jsx';
import GraphEditor from '../src/components/GraphEditor.jsx';
import App from '../src/App.jsx';
import { loadDemoGraph, randomGraph } from '../src/data/graphModel.js';
import { referenceCrossCheck } from '../src/reference/pagerankReference.js';

const BASE = process.env.BASE || 'http://localhost:5173';

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    const html = fn();
    if (typeof html === 'string' && html.length > 0) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); return html; }
    fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name} -- rendered nothing`);
  } catch (err) {
    fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}\n        ${err.message}`);
  }
  return '';
}

function contains(name, html, needle) {
  if (html.includes(needle)) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name} -- missing ${JSON.stringify(needle)}`); }
}

// ---- fetch real data from the live API -------------------------------
const graph = loadDemoGraph();

const sysRes = await fetch(`${BASE}/api/system`);
const system = await sysRes.json();

const runRes = await fetch(`${BASE}/api/pagerank/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    implementation: 'openmp', threads: 4,
    graph: { nodeIds: graph.nodeIds, edges: graph.edges },
    params: { damping: 0.85, tolerance: 1e-6, maxIterations: 100 },
  }),
});
const runPayload = await runRes.json();
if (!runPayload.ok) { console.error('API run failed:', runPayload); process.exit(1); }
const result = runPayload.result;

const cmpRes = await fetch(`${BASE}/api/pagerank/compare`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    generate: { nodes: 5000, degree: 6, seed: 42 },
    params: {}, threadCounts: [1, 2, 4], repeat: 2,
  }),
});
const compare = await cmpRes.json();
if (!compare.ok) { console.error('API compare failed:', compare); process.exit(1); }

console.log('\x1b[1mServer-render smoke test\x1b[0m');
console.log(`  API: ${BASE} · ${system.cpus} CPUs · ${system.ompMaxThreads} OpenMP threads\n`);

// ---- render every screen ---------------------------------------------
console.log('\x1b[1mScreens\x1b[0m');
const overview = check('OverviewTab', () => renderToStaticMarkup(<OverviewTab system={system} onOpenLab={() => {}} />));
contains('overview shows the machine thread count', overview, String(system.ompMaxThreads));
contains('overview marks the demo graph unsolved', overview, 'unsolved');

check('LabTab (initial)', () => renderToStaticMarkup(<LabTab system={system} />));
check('BenchmarkTab (initial)', () => renderToStaticMarkup(<BenchmarkTab system={system} />));
const code = check('CodeTab', () => renderToStaticMarkup(<CodeTab />));
contains('code tab shows the real compile command', code, 'gcc -O2 -Wall -o bin/serial_pagerank');
contains('code tab contains the C source', code, 'pagerank');
const archive = check('ArchiveTab', () => renderToStaticMarkup(<ArchiveTab />));
contains('archive is labelled historical', archive, 'historical numbers, not live measurements');
check('App shell', () => renderToStaticMarkup(<App />));

console.log('\n\x1b[1mComponents with real C data\x1b[0m');
const results = check('ResultsPanel with a real OpenMP result',
  () => renderToStaticMarkup(<ResultsPanel result={result} graph={graph} />));
contains('results show the OpenMP badge', results, 'OpenMP C');
contains('results show threads actually used', results, String(result.threads_used));
contains('results show the top PageRank value', results, result.pagerank[2].toFixed(8));
contains('results show thread work distribution', results, 'Thread work distribution');
contains('cross-check is labelled a reference implementation', results, 'reference JavaScript implementation');

const player = check('IterationPlayer with real history',
  () => renderToStaticMarkup(
    <IterationPlayer history={result.iteration_history} hasVectors={result.history_has_vectors}
                     nodeIds={result.nodeIds} cursor={3} onCursor={() => {}} />));
contains('player says the history came from C', player, 'replayed from the C run');
contains('player shows the recorded iteration count', player, `${result.iteration_history.length} recorded iterations`);

check('GraphCanvas unsolved', () => renderToStaticMarkup(<GraphCanvas graph={graph} ranks={null} />));
check('GraphCanvas with C ranks',
  () => renderToStaticMarkup(<GraphCanvas graph={graph} ranks={result.pagerank} threadOf={result.node_thread} />));
check('GraphCanvas empty graph',
  () => renderToStaticMarkup(<GraphCanvas graph={{ nodeIds: [], edges: [], positions: {} }} ranks={null} />));
check('GraphCanvas self-loop + reciprocal edges',
  () => renderToStaticMarkup(<GraphCanvas graph={{
    nodeIds: [0, 1], edges: [[0, 0], [0, 1], [1, 0]], positions: { 0: [100, 100], 1: [300, 200] },
  }} ranks={[0.6, 0.4]} />));
check('GraphCanvas 100-node random graph',
  () => renderToStaticMarkup(<GraphCanvas graph={randomGraph(100, 300)} ranks={null} />));
check('GraphEditor', () => renderToStaticMarkup(
  <GraphEditor graph={graph} onChange={() => {}} ranks={null} threadOf={null} disabled={false} />));

// ---- the reference implementation must agree with C -------------------
console.log('\n\x1b[1mReference cross-check (the only JS PageRank left)\x1b[0m');
const cc = referenceCrossCheck(graph, result);
if (cc.maxAbsDiff < 1e-9) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  JS reference agrees with C (max |diff| = ${cc.maxAbsDiff.toExponential(2)})`); }
else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  JS reference diverges from C: ${cc.maxAbsDiff}`); }

// ---- benchmark rendering with real measured data ----------------------
console.log('\n\x1b[1mBenchmark data shape\x1b[0m');
const okShape = compare.openmp.every((o) =>
  typeof o.timingMs === 'number' && typeof o.speedup === 'number' && typeof o.efficiency === 'number');
if (okShape) { pass++; console.log('  \x1b[32mPASS\x1b[0m  compare response carries measured timing/speedup/efficiency'); }
else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  compare response shape is wrong'); }
console.log(`        serial ${compare.serial.timingMs.toFixed(3)} ms · ` +
  compare.openmp.map((o) => `${o.threadsUsed}t ${o.speedup.toFixed(2)}x`).join(' · '));

console.log(`\n\x1b[1mSummary\x1b[0m: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
