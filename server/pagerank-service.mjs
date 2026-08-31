// =====================================================================
// PageRank execution service.
//
// This module is the ONLY place where PageRank is computed. It compiles
// c/serial_pagerank.c and c/openmp_pagerank.c with gcc and then executes
// the resulting binaries, handing them the user's graph on stdin and
// reading a JSON object back from stdout.
//
// Nothing here implements PageRank. If the C binaries are missing and
// cannot be built, requests fail loudly rather than falling back to a
// JavaScript computation -- a silent fallback is exactly the kind of
// "looks real but isn't" behaviour this architecture exists to prevent.
//
// Safety notes:
//   * Binaries are spawned with an ARGUMENT ARRAY and shell:false, so no
//     user-supplied value is ever interpreted by a shell.
//   * The graph travels over stdin, never over argv.
//   * Every numeric parameter is validated and clamped before it becomes
//     an argv entry.
//   * Child processes are killed on timeout and their output is capped.
// =====================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const C_DIR = path.join(ROOT, 'c');
const BIN_DIR = path.join(ROOT, 'bin');

// Interactive request ceilings. The C programs have their own much larger
// hard limits; these keep a browser request from monopolising the machine.
export const LIMITS = {
  maxNodes: 20000,
  maxEdges: 200000,
  maxGeneratedNodes: 2000000,
  maxThreads: 128,
  maxRepeat: 50,
  maxIterations: 10000,
  execTimeoutMs: 30000,
  maxStdoutBytes: 256 * 1024 * 1024,
};

export const TARGETS = {
  serial: {
    source: path.join(C_DIR, 'serial_pagerank.c'),
    binary: path.join(BIN_DIR, 'serial_pagerank'),
    compile: (src, out) => ['-O2', '-Wall', '-o', out, src, '-lm'],
  },
  openmp: {
    source: path.join(C_DIR, 'openmp_pagerank.c'),
    binary: path.join(BIN_DIR, 'openmp_pagerank'),
    compile: (src, out) => ['-O2', '-Wall', '-fopenmp', '-o', out, src, '-lm'],
  },
};

export class PageRankError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------

function runCommand(cmd, args, { input, timeoutMs, maxStdout } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), spawnError: err });
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let killedFor = null;

    const timer = timeoutMs
      ? setTimeout(() => { killedFor = 'timeout'; child.kill('SIGKILL'); }, timeoutMs)
      : null;

    child.stdout.on('data', (d) => {
      outBytes += d.length;
      if (maxStdout && outBytes > maxStdout) {
        killedFor = 'output-limit';
        child.kill('SIGKILL');
        return;
      }
      outChunks.push(d);
    });
    child.stderr.on('data', (d) => { if (errChunks.length < 256) errChunks.push(d); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: String(err), spawnError: err });
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        signal,
        killedFor,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });

    if (input !== undefined) {
      // The child may exit early (e.g. on a validation error) and close the
      // pipe; that EPIPE is expected and must not crash the server.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

async function mtimeOrNull(p) {
  try { return (await fsp.stat(p)).mtimeMs; } catch { return null; }
}

const buildLocks = new Map();

// Compile `which` if its binary is missing or older than its .c source.
// Concurrent callers share one compile via buildLocks.
export async function ensureBinary(which, { force = false } = {}) {
  const target = TARGETS[which];
  if (!target) throw new PageRankError(`unknown implementation "${which}"`);

  if (buildLocks.has(which)) return buildLocks.get(which);

  const job = (async () => {
    await fsp.mkdir(BIN_DIR, { recursive: true });
    const [srcTime, binTime] = await Promise.all([
      mtimeOrNull(target.source),
      mtimeOrNull(target.binary),
    ]);
    if (srcTime === null) {
      throw new PageRankError(`source file missing: ${path.relative(ROOT, target.source)}`, 500);
    }
    if (!force && binTime !== null && binTime >= srcTime) {
      return { rebuilt: false, binary: target.binary };
    }

    const args = target.compile(target.source, target.binary);
    const res = await runCommand('gcc', args, { timeoutMs: 120000 });

    if (res.spawnError) {
      throw new PageRankError(
        'gcc was not found on PATH. Install a C compiler with OpenMP support ' +
        '(e.g. `sudo apt install build-essential`) and reload.',
        500, { detail: res.stderr },
      );
    }
    if (res.code !== 0) {
      throw new PageRankError(
        `failed to compile ${path.relative(ROOT, target.source)}`,
        500, { detail: res.stderr.slice(0, 4000) },
      );
    }
    return { rebuilt: true, binary: target.binary, warnings: res.stderr.slice(0, 4000) };
  })().finally(() => buildLocks.delete(which));

  buildLocks.set(which, job);
  return job;
}

export async function ensureAllBinaries(opts) {
  const out = {};
  for (const which of Object.keys(TARGETS)) {
    try {
      out[which] = { ok: true, ...(await ensureBinary(which, opts)) };
    } catch (err) {
      out[which] = { ok: false, error: err.message, detail: err.detail };
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------

function num(value, name, { min, max, integer = false, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw new PageRankError(`${name} is required`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new PageRankError(`${name} must be a finite number`);
  if (integer && !Number.isInteger(n)) throw new PageRankError(`${name} must be an integer`);
  if (min !== undefined && n < min) throw new PageRankError(`${name} must be >= ${min}`);
  if (max !== undefined && n > max) throw new PageRankError(`${name} must be <= ${max}`);
  return n;
}

// Accepts the UI's graph shape and produces a dense 0..N-1 graph for C.
//
// The editor lets you delete nodes, so its ids have gaps (e.g. 0,1,4,7).
// The C program only understands contiguous ids, so we compact them here
// and hand the mapping back so results can be re-attached to real ids.
export function normalizeGraph(raw) {
  if (!raw || typeof raw !== 'object') throw new PageRankError('graph is required');

  let nodeIds;
  if (Array.isArray(raw.nodeIds)) {
    nodeIds = raw.nodeIds;
  } else if (Number.isInteger(raw.nodes)) {
    nodeIds = Array.from({ length: raw.nodes }, (_, i) => i);
  } else {
    throw new PageRankError('graph.nodeIds (array) or graph.nodes (integer) is required');
  }

  if (nodeIds.length > LIMITS.maxNodes) {
    throw new PageRankError(`graph has ${nodeIds.length} nodes; the interactive limit is ${LIMITS.maxNodes}`);
  }

  const indexOf = new Map();
  for (const id of nodeIds) {
    if (!Number.isInteger(id)) throw new PageRankError('every node id must be an integer');
    if (indexOf.has(id)) throw new PageRankError(`duplicate node id ${id}`);
    indexOf.set(id, indexOf.size);
  }

  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  if (rawEdges.length > LIMITS.maxEdges) {
    throw new PageRankError(`graph has ${rawEdges.length} edges; the interactive limit is ${LIMITS.maxEdges}`);
  }

  const edges = [];
  let selfLoops = 0;
  const seen = new Set();
  let duplicates = 0;

  for (const edge of rawEdges) {
    let u, v;
    if (Array.isArray(edge)) { [u, v] = edge; }
    else if (edge && typeof edge === 'object') { u = edge.from ?? edge.u; v = edge.to ?? edge.v; }
    else throw new PageRankError('each edge must be [u, v] or {from, to}');

    if (!indexOf.has(u)) throw new PageRankError(`edge source ${JSON.stringify(u)} is not a node in this graph`);
    if (!indexOf.has(v)) throw new PageRankError(`edge target ${JSON.stringify(v)} is not a node in this graph`);

    const du = indexOf.get(u);
    const dv = indexOf.get(v);
    if (du === dv) selfLoops++;
    const key = `${du}>${dv}`;
    if (seen.has(key)) duplicates++;
    seen.add(key);
    edges.push([du, dv]);
  }

  return { nodeIds, edges, N: nodeIds.length, E: edges.length, selfLoops, duplicates };
}

// Serialise to the C program's stdin format: "N M" then M lines of "u v".
function encodeGraph(dense) {
  const parts = [`${dense.N} ${dense.E}\n`];
  // Chunked to avoid building one enormous string for large graphs.
  const CHUNK = 4096;
  let buf = [];
  for (let i = 0; i < dense.edges.length; i++) {
    buf.push(`${dense.edges[i][0]} ${dense.edges[i][1]}\n`);
    if (buf.length >= CHUNK) { parts.push(buf.join('')); buf = []; }
  }
  if (buf.length) parts.push(buf.join(''));
  return parts.join('');
}

export function normalizeParams(raw = {}) {
  return {
    damping: num(raw.damping, 'damping', { min: 0, max: 0.999999, fallback: 0.85 }),
    tolerance: num(raw.tolerance, 'tolerance', { min: 1e-15, max: 1, fallback: 1e-6 }),
    maxIterations: num(raw.maxIterations, 'maxIterations', {
      min: 1, max: LIMITS.maxIterations, integer: true, fallback: 100,
    }),
  };
}

// ---------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------

/**
 * Runs one C binary on one graph and returns its parsed JSON output.
 *
 * `source` is either { graph: <normalized dense graph> } for a user graph
 * sent over stdin, or { generate: {nodes, degree, seed} } to have the C
 * program build a reproducible random graph itself (used by the benchmark
 * workflow so 600k edges never have to cross the network).
 */
export async function execute({
  implementation,
  graph = null,
  generate = null,
  params,
  threads = null,
  history = true,
  historyCap = 1000,
  repeat = 1,
}) {
  if (implementation !== 'serial' && implementation !== 'openmp') {
    throw new PageRankError('implementation must be "serial" or "openmp"');
  }
  if (!graph && !generate) throw new PageRankError('either a graph or a generate spec is required');

  await ensureBinary(implementation);
  const target = TARGETS[implementation];

  // Normalising again here is idempotent, and it guarantees that no caller
  // can reach the argv builder with an unvalidated number.
  const p = normalizeParams(params);

  const args = ['--json'];
  args.push('--damping', String(p.damping));
  args.push('--tol', String(p.tolerance));
  args.push('--max-iter', String(p.maxIterations));
  args.push('--repeat', String(num(repeat, 'repeat', { min: 1, max: LIMITS.maxRepeat, integer: true, fallback: 1 })));
  args.push('--history', history ? '1' : '0');
  args.push('--history-cap', String(num(historyCap, 'historyCap', { min: 0, max: 20000, integer: true, fallback: 1000 })));

  if (generate) {
    const n = num(generate.nodes, 'generate.nodes', { min: 0, max: LIMITS.maxGeneratedNodes, integer: true });
    const deg = num(generate.degree, 'generate.degree', { min: 0, max: 64, integer: true, fallback: 6 });
    const seed = num(generate.seed, 'generate.seed', { min: 0, max: 2 ** 31 - 1, integer: true, fallback: 42 });
    args.push('--generate', String(n), '--degree', String(deg), '--seed', String(seed));
  }

  if (implementation === 'openmp' && threads !== null && threads !== undefined) {
    args.push('--threads', String(num(threads, 'threads', { min: 1, max: LIMITS.maxThreads, integer: true })));
  }

  const stdin = generate ? '' : encodeGraph(graph);

  const started = Date.now();
  const res = await runCommand(target.binary, args, {
    input: stdin,
    timeoutMs: LIMITS.execTimeoutMs,
    maxStdout: LIMITS.maxStdoutBytes,
  });
  const wallMs = Date.now() - started;

  if (res.spawnError) {
    throw new PageRankError(`could not start ${path.basename(target.binary)}`, 500, { detail: res.stderr });
  }
  if (res.killedFor === 'timeout') {
    throw new PageRankError(
      `the C program exceeded the ${LIMITS.execTimeoutMs / 1000}s time limit; try a smaller graph or fewer iterations`,
      504,
    );
  }
  if (res.killedFor === 'output-limit') {
    throw new PageRankError('the C program produced more output than the server will buffer', 507);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new PageRankError(
      `${path.basename(target.binary)} did not return valid JSON (exit code ${res.code})`,
      502,
      { detail: (res.stderr || res.stdout).slice(0, 2000) },
    );
  }

  if (parsed.error) {
    // A validation failure raised inside the C program itself.
    throw new PageRankError(parsed.error, 400, { origin: 'c-program' });
  }
  if (res.code !== 0) {
    throw new PageRankError(`${path.basename(target.binary)} exited with code ${res.code}`, 502, { detail: res.stderr });
  }

  return {
    ...parsed,
    // Provenance the UI displays so a user can tell where a number came from.
    executedBy: {
      binary: path.relative(ROOT, target.binary),
      argv: args,
      wallMsIncludingProcessStartup: wallMs,
      host: os.hostname(),
    },
    nodeIds: graph ? graph.nodeIds : null,
  };
}

// ---------------------------------------------------------------------
// System information
// ---------------------------------------------------------------------

export async function systemInfo() {
  const gcc = await runCommand('gcc', ['--version'], { timeoutMs: 5000 });
  const binaries = {};
  for (const [name, t] of Object.entries(TARGETS)) {
    binaries[name] = {
      source: path.relative(ROOT, t.source),
      binary: path.relative(ROOT, t.binary),
      compiled: fs.existsSync(t.binary),
      sourceMtime: await mtimeOrNull(t.source),
      binaryMtime: await mtimeOrNull(t.binary),
    };
  }

  // Ask the OpenMP runtime itself rather than guessing from os.cpus().
  let ompMaxThreads = null;
  if (binaries.openmp.compiled) {
    const probe = await runCommand(TARGETS.openmp.binary, [
      '--json', '--generate', '1', '--degree', '0', '--history', '0',
    ], { timeoutMs: 10000, maxStdout: 1 << 20 });
    try { ompMaxThreads = JSON.parse(probe.stdout).max_threads_available ?? null; } catch { /* leave null */ }
  }

  return {
    cpus: os.cpus().length,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    hostname: os.hostname(),
    gcc: gcc.code === 0 ? gcc.stdout.split('\n')[0] : null,
    gccAvailable: gcc.code === 0,
    ompMaxThreads,
    binaries,
    limits: LIMITS,
  };
}

// Sensible thread ladder for the benchmark tab: powers of two up to the
// core count, always including 1 and the core count itself.
export function suggestedThreadCounts(cpus) {
  const set = new Set([1]);
  for (let t = 2; t <= cpus; t *= 2) set.add(t);
  if (cpus >= 1) set.add(cpus);
  return [...set].sort((a, b) => a - b).slice(0, 8);
}
