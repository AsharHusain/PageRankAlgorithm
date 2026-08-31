// =====================================================================
// HTTP API, written as connect-style middleware so the same code can be
// mounted inside the Vite dev server (see vite.config.js) and inside the
// standalone production server (see server/standalone.mjs).
//
// Endpoints
//   GET  /api/system              compiler + CPU + binary status
//   POST /api/build               force a recompile of both C programs
//   POST /api/pagerank/run        run one implementation on one graph
//   POST /api/pagerank/compare    serial vs OpenMP across thread counts
//
// Every one of these ends in a spawned C process. There is no JavaScript
// PageRank path in this file, deliberately.
// =====================================================================

import {
  execute, normalizeGraph, normalizeParams, systemInfo, ensureAllBinaries,
  suggestedThreadCounts, PageRankError, LIMITS,
} from './pagerank-service.mjs';

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new PageRankError('request body too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); }
      catch { reject(new PageRankError('request body is not valid JSON', 400)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

// Shared by /run and /compare: turn a request body into something the
// service can execute, whether that is a user-drawn graph or a
// server-generated benchmark graph.
function resolveSource(body) {
  if (body.generate) {
    return { generate: body.generate, graph: null };
  }
  return { generate: null, graph: normalizeGraph(body.graph) };
}

async function handleRun(body) {
  const { graph, generate } = resolveSource(body);
  const params = normalizeParams(body.params);
  const implementation = body.implementation;

  const result = await execute({
    implementation,
    graph,
    generate,
    params,
    threads: implementation === 'openmp' ? (body.threads ?? null) : null,
    history: body.history !== false,
    historyCap: body.historyCap ?? 1000,
    repeat: body.repeat ?? 1,
  });

  return {
    ok: true,
    result,
    graphInfo: graph
      ? { nodes: graph.N, edges: graph.E, selfLoops: graph.selfLoops, duplicates: graph.duplicates }
      : { generated: true },
  };
}

async function handleCompare(body) {
  const { graph, generate } = resolveSource(body);
  const params = normalizeParams(body.params);
  const repeat = body.repeat ?? 3;

  const info = await systemInfo();
  const threadCounts = Array.isArray(body.threadCounts) && body.threadCounts.length
    ? body.threadCounts
    : suggestedThreadCounts(info.ompMaxThreads || info.cpus);

  if (threadCounts.length > 12) throw new PageRankError('at most 12 thread counts per comparison');

  // History is off here: the comparison is about timing, and we do not
  // want the history replay pass anywhere near a benchmark run.
  const common = { graph, generate, params, history: false, repeat };

  const serial = await execute({ ...common, implementation: 'serial' });

  const openmp = [];
  for (const threads of threadCounts) {
    const r = await execute({ ...common, implementation: 'openmp', threads });
    openmp.push({
      threadsRequested: threads,
      threadsUsed: r.threads_used,
      timingMs: r.timing_ms,
      iterations: r.iterations,
      converged: r.converged,
      // Both figures are derived purely from the two measured wall times.
      speedup: r.timing_ms > 0 ? serial.timing_ms / r.timing_ms : null,
      efficiency: r.timing_ms > 0 && r.threads_used > 0
        ? (serial.timing_ms / r.timing_ms) / r.threads_used
        : null,
      finalDifference: r.final_difference,
      threadWork: r.thread_work,
      executedBy: r.executedBy,
    });
  }

  // Correctness cross-check between the two C programs on this same graph.
  let maxAbsDiff = null;
  const serialPR = serial.pagerank;
  if (openmp.length) {
    const verify = await execute({
      ...common,
      implementation: 'openmp',
      threads: threadCounts[threadCounts.length - 1],
    });
    if (Array.isArray(verify.pagerank) && verify.pagerank.length === serialPR.length) {
      maxAbsDiff = 0;
      for (let i = 0; i < serialPR.length; i++) {
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(serialPR[i] - verify.pagerank[i]));
      }
    }
  }

  return {
    ok: true,
    graphInfo: graph
      ? { nodes: graph.N, edges: graph.E }
      : { generated: true, nodes: serial.nodes, edges: serial.edges },
    params,
    repeat,
    serial: {
      timingMs: serial.timing_ms,
      iterations: serial.iterations,
      converged: serial.converged,
      finalDifference: serial.final_difference,
      rankSum: serial.rank_sum,
      executedBy: serial.executedBy,
    },
    openmp,
    verification: {
      maxAbsDifferenceSerialVsOpenmp: maxAbsDiff,
      rankSum: serial.rank_sum,
    },
    system: { cpus: info.cpus, ompMaxThreads: info.ompMaxThreads },
  };
}

const ROUTES = {
  'GET /api/system': async () => ({ ok: true, ...(await systemInfo()) }),
  'POST /api/build': async () => ({ ok: true, binaries: await ensureAllBinaries({ force: true }) }),
  'POST /api/pagerank/run': handleRun,
  'POST /api/pagerank/compare': handleCompare,
};

export function createApiMiddleware({ logger = console } = {}) {
  return async function apiMiddleware(req, res, next) {
    const url = (req.url || '').split('?')[0];
    if (!url.startsWith('/api/')) return next();

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      res.end();
      return;
    }

    const key = `${req.method} ${url}`;
    const handler = ROUTES[key];
    if (!handler) {
      sendJson(res, 404, { ok: false, error: `no such endpoint: ${key}` });
      return;
    }

    const started = Date.now();
    try {
      const body = req.method === 'POST' ? await readJsonBody(req) : {};
      const payload = await handler(body);
      logger.log?.(`[api] ${key} -> 200 (${Date.now() - started}ms)`);
      sendJson(res, 200, payload);
    } catch (err) {
      const status = err instanceof PageRankError ? err.status : 500;
      logger.error?.(`[api] ${key} -> ${status}: ${err.message}`);
      if (status >= 500 && err.stack && !(err instanceof PageRankError)) logger.error?.(err.stack);
      sendJson(res, status, {
        ok: false,
        error: err.message || 'internal error',
        detail: err.detail,
        origin: err.origin,
      });
    }
  };
}

export { LIMITS };
