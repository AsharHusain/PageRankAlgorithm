// =====================================================================
// Correctness suite for the C PageRank implementations, exercised through
// exactly the same service layer the HTTP API uses.
//
//     npm run verify
//
// This is the regression test for the whole stack: if these pass, the
// browser is talking to a C program that computes PageRank correctly.
// =====================================================================

import {
  execute, normalizeGraph, normalizeParams, systemInfo, ensureAllBinaries,
} from '../server/pagerank-service.mjs';

let passed = 0, failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { failed++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` -- ${detail}` : ''}`); }
}

function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

const P = normalizeParams({});

async function run(implementation, graphSpec, extra = {}) {
  return execute({
    ...extra,
    implementation,
    graph: normalizeGraph(graphSpec),
    params: extra.params ? normalizeParams(extra.params) : P,
  });
}

function sum(a) { return a.reduce((x, y) => x + y, 0); }
function maxAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

// ---------------------------------------------------------------------

const info = await systemInfo();
console.log(`\x1b[1mPageRank C implementation verification\x1b[0m`);
console.log(`  ${info.gcc}`);
console.log(`  ${info.cpus} CPUs, OpenMP reports ${info.ompMaxThreads} threads\n`);

const build = await ensureAllBinaries();
for (const [name, r] of Object.entries(build)) {
  check(`compiles: ${name}`, r.ok, r.error);
}
if (Object.values(build).some((r) => !r.ok)) {
  console.error('\nCannot continue without both binaries.');
  process.exit(1);
}

// ------------------------- 1. demo graph regression -------------------
section('1. Demonstration graph (N=6, E=8) -- regression against known values');

const DEMO = {
  nodeIds: [0, 1, 2, 3, 4, 5],
  edges: [[0, 1], [0, 2], [1, 2], [2, 0], [3, 0], [3, 2], [4, 3], [4, 5]],
};
// These are the values the original, pre-refactor C program produced and
// which outputs/serial_output.txt recorded. They must not move.
const EXPECTED = [0.348745, 0.179540, 0.351120, 0.044636, 0.031323, 0.044636];

const demoSerial = await run('serial', DEMO);
const demoOmp = await run('openmp', DEMO, { threads: 4 });

check('serial converges in 25 iterations', demoSerial.iterations === 25, `got ${demoSerial.iterations}`);
check('serial matches the recorded PageRank vector (1e-6)',
  maxAbsDiff(demoSerial.pagerank, EXPECTED) < 1e-6,
  `max |diff| = ${maxAbsDiff(demoSerial.pagerank, EXPECTED)}`);
check('openmp matches the recorded PageRank vector (1e-6)',
  maxAbsDiff(demoOmp.pagerank, EXPECTED) < 1e-6,
  `max |diff| = ${maxAbsDiff(demoOmp.pagerank, EXPECTED)}`);
check('serial and openmp agree (1e-12)',
  maxAbsDiff(demoSerial.pagerank, demoOmp.pagerank) < 1e-12,
  `max |diff| = ${maxAbsDiff(demoSerial.pagerank, demoOmp.pagerank)}`);
check('ranks sum to 1', Math.abs(sum(demoSerial.pagerank) - 1) < 1e-9);
check('dangling node 5 detected', demoSerial.dangling_nodes === 1, `got ${demoSerial.dangling_nodes}`);
check('iteration history covers every iteration',
  demoSerial.iteration_history.length === demoSerial.iterations + 1,
  `${demoSerial.iteration_history.length} entries for ${demoSerial.iterations} iterations`);
check('iteration 0 is the uniform vector',
  demoSerial.iteration_history[0].pagerank.every((v) => Math.abs(v - 1 / 6) < 1e-12));
check('last history entry equals the final vector',
  maxAbsDiff(demoSerial.iteration_history.at(-1).pagerank, demoSerial.pagerank) === 0);
check('L1 difference decreases to below tolerance',
  demoSerial.iteration_history.at(-1).difference < 1e-6);
check('openmp reports the thread team it actually used',
  demoOmp.threads_used === 4, `got ${demoOmp.threads_used}`);
check('thread work distribution covers all nodes',
  demoOmp.thread_work.reduce((a, t) => a + t.nodes, 0) === 6);

// ------------------------- 2. structural edge cases -------------------
section('2. Graph structure edge cases');

// Single node, no edges.
const single = await run('serial', { nodeIds: [0], edges: [] });
check('single node: PR = [1]', Math.abs(single.pagerank[0] - 1) < 1e-12, JSON.stringify(single.pagerank));

// No edges at all: every node dangling -> uniform distribution.
const noEdges = await run('serial', { nodeIds: [0, 1, 2, 3], edges: [] });
check('no edges: uniform 1/N', noEdges.pagerank.every((v) => Math.abs(v - 0.25) < 1e-12));
check('no edges: all 4 nodes dangling', noEdges.dangling_nodes === 4);

// Pure cycle: symmetric, so every node must get exactly 1/N.
const cycle = await run('serial', { nodeIds: [0, 1, 2, 3], edges: [[0, 1], [1, 2], [2, 3], [3, 0]] });
check('4-cycle: uniform 1/N', cycle.pagerank.every((v) => Math.abs(v - 0.25) < 1e-6),
  JSON.stringify(cycle.pagerank.map((v) => v.toFixed(6))));

// Two disconnected 2-cycles: each component symmetric.
const disconnected = await run('serial', {
  nodeIds: [0, 1, 2, 3], edges: [[0, 1], [1, 0], [2, 3], [3, 2]],
});
check('disconnected components: uniform 1/N',
  disconnected.pagerank.every((v) => Math.abs(v - 0.25) < 1e-6));
check('disconnected: ranks still sum to 1', Math.abs(sum(disconnected.pagerank) - 1) < 1e-9);

// Isolated node alongside a connected pair.
const isolated = await run('serial', { nodeIds: [0, 1, 2], edges: [[0, 1], [1, 0]] });
check('isolated node gets the lowest rank',
  isolated.pagerank[2] < isolated.pagerank[0] && isolated.pagerank[2] < isolated.pagerank[1],
  JSON.stringify(isolated.pagerank.map((v) => v.toFixed(6))));
check('isolated node: ranks sum to 1', Math.abs(sum(isolated.pagerank) - 1) < 1e-9);

// Dangling node absorbs then redistributes: total mass preserved.
const dangling = await run('serial', { nodeIds: [0, 1, 2], edges: [[0, 1], [1, 2]] });
check('chain with dangling tail: ranks sum to 1', Math.abs(sum(dangling.pagerank) - 1) < 1e-9);
check('chain with dangling tail: tail ranks highest',
  dangling.pagerank[2] === Math.max(...dangling.pagerank));

// Self-loop and duplicate edge are accepted as legitimate multigraph input.
const selfLoop = await run('serial', { nodeIds: [0, 1], edges: [[0, 0], [0, 1]] });
check('self-loop: ranks sum to 1', Math.abs(sum(selfLoop.pagerank) - 1) < 1e-9);
const dup = normalizeGraph({ nodeIds: [0, 1], edges: [[0, 1], [0, 1]] });
check('duplicate edges are counted and reported', dup.duplicates === 1, `got ${dup.duplicates}`);
const loopInfo = normalizeGraph({ nodeIds: [0, 1], edges: [[0, 0], [0, 1]] });
check('self-loops are counted and reported', loopInfo.selfLoops === 1, `got ${loopInfo.selfLoops}`);

// Sparse ids (what the editor produces after deletions) must be compacted.
const sparse = await run('serial', { nodeIds: [3, 9, 40], edges: [[3, 9], [9, 40], [40, 3]] });
check('non-contiguous node ids are remapped correctly',
  sparse.nodes === 3 && sparse.pagerank.every((v) => Math.abs(v - 1 / 3) < 1e-6));
check('response carries the original node ids back',
  JSON.stringify(sparse.nodeIds) === JSON.stringify([3, 9, 40]));

// Empty graph.
const empty = await run('serial', { nodeIds: [], edges: [] });
check('empty graph returns an empty result rather than an error',
  empty.nodes === 0 && empty.pagerank.length === 0);

// ------------------------- 3. rejected input --------------------------
section('3. Invalid input is rejected, not silently accepted');

async function expectReject(name, fn) {
  try { await fn(); check(name, false, 'no error thrown'); }
  catch { check(name, true); }
}

await expectReject('edge referencing an unknown node id',
  () => run('serial', { nodeIds: [0, 1], edges: [[0, 7]] }));
await expectReject('duplicate node ids',
  () => run('serial', { nodeIds: [0, 0], edges: [] }));
await expectReject('non-integer node id',
  () => run('serial', { nodeIds: [0, 1.5], edges: [] }));
await expectReject('damping >= 1',
  () => run('serial', DEMO, { params: { damping: 1 } }));
await expectReject('negative damping',
  () => run('serial', DEMO, { params: { damping: -0.1 } }));
await expectReject('zero tolerance',
  () => run('serial', DEMO, { params: { tolerance: 0 } }));
await expectReject('maxIterations = 0',
  () => run('serial', DEMO, { params: { maxIterations: 0 } }));
await expectReject('unknown implementation name',
  () => execute({ implementation: 'javascript', graph: normalizeGraph(DEMO), params: P }));

// ------------------------- 4. parameter behaviour ---------------------
section('4. Parameters actually change the computation');

const d50 = await run('serial', DEMO, { params: { damping: 0.5 } });
check('a different damping factor yields a different vector',
  maxAbsDiff(d50.pagerank, demoSerial.pagerank) > 1e-3);
check('damping is echoed back from C', d50.damping === 0.5);

const capped = await run('serial', DEMO, { params: { maxIterations: 3 } });
check('maxIterations caps the run', capped.iterations === 3, `got ${capped.iterations}`);
check('a capped run reports converged=false', capped.converged === false);

const loose = await run('serial', DEMO, { params: { tolerance: 1e-2 } });
check('a looser tolerance converges sooner', loose.iterations < demoSerial.iterations,
  `${loose.iterations} vs ${demoSerial.iterations}`);

// ------------------------- 5. random + parallel scaling ---------------
section('5. Generated graphs and real OpenMP scaling');

const genSerial = await execute({
  implementation: 'serial', generate: { nodes: 20000, degree: 6, seed: 42 },
  params: P, history: false, repeat: 2,
});
check('generated graph (N=20000) runs', genSerial.nodes === 20000 && genSerial.converged);
check('generated graph: ranks sum to 1', Math.abs(genSerial.rank_sum - 1) < 1e-6);

const genOmpA = await execute({
  implementation: 'openmp', generate: { nodes: 20000, degree: 6, seed: 42 },
  params: P, history: false, repeat: 2, threads: 1,
});
const genOmpB = await execute({
  implementation: 'openmp', generate: { nodes: 20000, degree: 6, seed: 42 },
  params: P, history: false, repeat: 2, threads: 4,
});
check('serial and openmp agree on a 20k-node graph (1e-9)',
  maxAbsDiff(genSerial.pagerank, genOmpB.pagerank) < 1e-9,
  `max |diff| = ${maxAbsDiff(genSerial.pagerank, genOmpB.pagerank)}`);
check('openmp honoured --threads 1', genOmpA.threads_used === 1);
check('openmp honoured --threads 4', genOmpB.threads_used === 4,
  `got ${genOmpB.threads_used}`);
check('thread work is distributed across the whole team',
  genOmpB.thread_work.length === 4 && genOmpB.thread_work.every((t) => t.nodes > 0));
check('timing is a positive measured number',
  genSerial.timing_ms > 0 && genOmpB.timing_ms > 0);

if (info.ompMaxThreads >= 4) {
  console.log(`        (1 thread: ${genOmpA.timing_ms.toFixed(3)} ms, ` +
              `4 threads: ${genOmpB.timing_ms.toFixed(3)} ms, ` +
              `speedup ${(genOmpA.timing_ms / genOmpB.timing_ms).toFixed(2)}x)`);
}

// History suppression on large graphs.
const bigHist = await execute({
  implementation: 'serial', generate: { nodes: 5000, degree: 4, seed: 7 },
  params: P, history: true, historyCap: 1000,
});
check('large graph keeps L1 history but drops PR vectors',
  bigHist.history_has_vectors === false && bigHist.iteration_history.length > 1
  && bigHist.iteration_history[1].pagerank === undefined);

// ------------------------- summary ------------------------------------
console.log(`\n\x1b[1mSummary\x1b[0m: ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
