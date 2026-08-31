/* =====================================================================
   CSS 311 - Parallel and Distributed Computing : Assignment I
   Topic     : PageRank Algorithm - SERIAL (C)
   Name      : <FILL_YOUR_NAME>
   Roll No   : <FILL_YOUR_ROLL_NO>

   Representation: directed graph stored as a reverse (in-link) adjacency
   list in CSR form -- for every node v we can walk exactly the nodes u
   with an edge u->v. This gives O(V+E) work per power-iteration pass
   (NOT O(V^2): we never touch a full N x N adjacency matrix).

   ---------------------------------------------------------------------
   THIS PROGRAM HAS TWO MODES
   ---------------------------------------------------------------------
     (1) No arguments  -> the original assignment behaviour: the 6-node
                          demonstration graph plus the small/medium/large
                          benchmark suite, printed human-readably.
                          (This is what outputs/serial_output.txt captured.)

     (2) --json        -> reads an ARBITRARY graph and prints one
                          machine-readable JSON object on stdout.
                          This is the mode the web backend invokes, so
                          every number the browser shows is computed here,
                          in C, on the user's own graph.

   JSON-mode graph input (stdin, whitespace separated):

        N M
        u1 v1
        u2 v2
        ...
        uM vM

   ...or, instead of stdin, use --generate <N> to build a reproducible
   random graph directly in C (used by the benchmark workflow so that
   600k edges never have to travel over HTTP).

   Options (JSON mode):
     --damping <d>       teleport/damping factor            (default 0.85)
     --tol <t>           L1 convergence tolerance           (default 1e-6)
     --max-iter <n>      iteration cap                      (default 100)
     --repeat <n>        time the solve n times, report the
                         FASTEST wall time                  (default 1)
     --history <0|1>     record per-iteration data          (default 1)
     --history-cap <n>   only store full PR vectors when
                         N <= this                          (default 1000)
     --generate <N>      build a random graph instead of reading stdin
     --degree <d>        average out-degree for --generate  (default 6)
     --seed <s>          RNG seed for --generate            (default 42)

   Example:
        printf '3 3\n0 1\n1 2\n2 0\n' | ./serial_pagerank --json
   ===================================================================== */
#define _POSIX_C_SOURCE 199309L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

#define DAMPING   0.85
#define TOL       1e-6
#define MAXITER   100

#define HISTORY_NODE_CAP_DEFAULT 1000

/* Hard safety limits. The backend enforces much smaller caps for
   interactive requests; these exist so that a malformed input can never
   make the process try to allocate an absurd amount of memory. */
#define MAX_NODES   5000000
#define MAX_EDGES  40000000

/* Set once we know we must speak JSON, so error reporting stays parseable. */
static int g_jsonMode = 0;

/* ---------------------------------------------------------------------
   Graph: reverse adjacency (who points TO each node) in CSR form.
   --------------------------------------------------------------------- */
typedef struct {
    int N, E;
    int *outdeg;      /* outdeg[u]                                   */
    int *inStart;     /* CSR row pointer, size N+1                   */
    int *inList;      /* CSR column list (source nodes), size E      */
} Graph;

/* Per-iteration record of the real solve, so the UI can animate the
   ACTUAL convergence instead of recomputing anything itself.
   `vectors` is NULL for large graphs (see --history-cap): we always keep
   the L1 differences, but full PR snapshots would be megabytes. */
typedef struct {
    int     capacity;   /* max iterations we can record                  */
    int     count;      /* iterations actually recorded (incl. iter 0)   */
    int     vectorLen;  /* N when PR snapshots are stored, else 0        */
    double *diffs;      /* [capacity]; diffs[0] is unused (iteration 0)  */
    double *vectors;    /* [capacity * vectorLen] or NULL                */
} History;

/* --------------------------- small helpers -------------------------- */

static double nowSeconds(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) { fprintf(stderr, "out of memory\n"); exit(3); }
    return p;
}

static void *xcalloc(size_t n, size_t sz) {
    void *p = calloc(n ? n : 1, sz);
    if (!p) { fprintf(stderr, "out of memory\n"); exit(3); }
    return p;
}

/* Print a JSON string body with the characters JSON requires escaped. */
static void jsonEscaped(const char *s) {
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        switch (c) {
            case '"':  fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\n': fputs("\\n", stdout);  break;
            case '\r': fputs("\\r", stdout);  break;
            case '\t': fputs("\\t", stdout);  break;
            default:
                if (c < 0x20) printf("\\u%04x", c);
                else          fputc(c, stdout);
        }
    }
}

/* JSON has no inf/nan literals -- emit null so the response always parses. */
static void jsonNumber(double v) {
    if (isfinite(v)) printf("%.12g", v);
    else             fputs("null", stdout);
}

/* Fail loudly but in a shape the caller can understand. */
static void fail(const char *msg) {
    if (g_jsonMode) {
        fputs("{\"error\":\"", stdout);
        jsonEscaped(msg);
        fputs("\"}\n", stdout);
        fflush(stdout);
    } else {
        fprintf(stderr, "error: %s\n", msg);
    }
    exit(2);
}

/* ------------------------- graph construction ----------------------- */

/* Build reverse-adjacency (who points TO each node) in CSR form from
   an edge list edges[e][0]=u -> edges[e][1]=v                       */
Graph buildGraph(int N, int E, int (*edges)[2]) {
    Graph g; g.N = N; g.E = E;
    g.outdeg = xcalloc((size_t)N, sizeof(int));
    int *inCount = xcalloc((size_t)N, sizeof(int));
    for (int e = 0; e < E; e++) {
        g.outdeg[edges[e][0]]++;
        inCount[edges[e][1]]++;
    }
    g.inStart = xmalloc(((size_t)N + 1) * sizeof(int));
    g.inStart[0] = 0;
    for (int i = 0; i < N; i++) g.inStart[i + 1] = g.inStart[i] + inCount[i];
    g.inList = xmalloc((size_t)E * sizeof(int));
    int *cursor = xmalloc((size_t)N * sizeof(int));
    memcpy(cursor, g.inStart, (size_t)N * sizeof(int));
    for (int e = 0; e < E; e++) {
        int v = edges[e][1];
        g.inList[cursor[v]++] = edges[e][0];
    }
    free(inCount); free(cursor);
    return g;
}

void freeGraph(Graph *g) { free(g->outdeg); free(g->inStart); free(g->inList); }

/* ---------------------------- the algorithm ------------------------- */

/* Power-iteration PageRank.

   PR(v) = (1-d)/N + d * ( SUM_{u->v} PR(u)/outdeg(u) + danglingSum/N )

   `hist` may be NULL. When it is NULL the loop below carries ZERO
   instrumentation -- that is the version we time, so recording history
   can never inflate the reported runtime.

   Returns the number of iterations performed.                        */
int pagerank(const Graph *g, double *PR, double d, double tol, int maxIter,
             int verbose, History *hist, double *finalDiff, int *converged)
{
    int N = g->N;
    double *newPR = xmalloc((size_t)N * sizeof(double));
    for (int i = 0; i < N; i++) PR[i] = 1.0 / N;

    if (hist) {
        hist->count = 1;                     /* iteration 0 = initial vector */
        hist->diffs[0] = 0.0;
        if (hist->vectors)
            memcpy(hist->vectors, PR, (size_t)N * sizeof(double));
    }

    double diff = 0.0;
    int conv = 0;
    int iter;
    for (iter = 0; iter < maxIter; iter++) {
        /* Rank mass sitting on dangling nodes (no out-links) is spread
           evenly over every node, otherwise total rank would leak away. */
        double danglingSum = 0.0;
        for (int u = 0; u < N; u++) if (g->outdeg[u] == 0) danglingSum += PR[u];

        for (int v = 0; v < N; v++) {
            double sum = 0.0;
            for (int k = g->inStart[v]; k < g->inStart[v + 1]; k++) {
                int u = g->inList[k];
                sum += PR[u] / g->outdeg[u];
            }
            newPR[v] = (1.0 - d) / N + d * (sum + danglingSum / N);
        }

        diff = 0.0;
        for (int i = 0; i < N; i++) diff += fabs(newPR[i] - PR[i]);
        memcpy(PR, newPR, (size_t)N * sizeof(double));

        if (hist && hist->count < hist->capacity) {
            int slot = hist->count++;
            hist->diffs[slot] = diff;
            if (hist->vectors)
                memcpy(hist->vectors + (size_t)slot * hist->vectorLen,
                       PR, (size_t)N * sizeof(double));
        }

        if (verbose) {
            printf("  iter %2d : L1 diff = %.8f", iter + 1, diff);
            if (iter < 5) { printf("   PR = ["); for (int i=0;i<N;i++) printf("%.4f%s", PR[i], i==N-1?"":", "); printf("]"); }
            printf("\n");
        }
        if (diff < tol) { iter++; conv = 1; break; }
    }
    free(newPR);
    if (finalDiff) *finalDiff = diff;
    if (converged) *converged = conv;
    return iter;
}

/* Random directed graph, avg out-degree ~ deg, seeded for reproducibility */
int genRandomGraph(int N, int deg, unsigned seed, int (**edges)[2]) {
    srand(seed);
    long long cap = (long long)N * deg;
    if (cap > MAX_EDGES) fail("generated graph would exceed the edge limit");
    int (*e)[2] = xmalloc((size_t)cap * sizeof(*e));
    int E = 0;
    for (int u = 0; u < N; u++)
        for (int k = 0; k < deg; k++) {
            int v = rand() % N;
            if (v == u) continue;          /* skip self-loops */
            e[E][0] = u; e[E][1] = v; E++;
        }
    *edges = e;
    return E;
}

/* --------------------------- stdin graph ---------------------------- */

/* Reads "N M" then M lines of "u v". Every id is bounds-checked, so a
   malformed request produces a clean error instead of a segfault. */
static int readGraphFromStdin(int *outN, int (**outEdges)[2]) {
    long long N = 0, M = 0;
    if (scanf("%lld %lld", &N, &M) != 2)
        fail("could not read the header line: expected \"N M\"");
    if (N < 0 || N > MAX_NODES) fail("node count out of range");
    if (M < 0 || M > MAX_EDGES) fail("edge count out of range");
    if (N == 0 && M > 0)        fail("a graph with 0 nodes cannot have edges");

    int (*e)[2] = (M > 0) ? xmalloc((size_t)M * sizeof(*e)) : NULL;
    for (long long i = 0; i < M; i++) {
        long long u, v;
        if (scanf("%lld %lld", &u, &v) != 2) {
            free(e);
            fail("unexpected end of input while reading the edge list");
        }
        if (u < 0 || u >= N || v < 0 || v >= N) {
            free(e);
            fail("edge references a node id outside [0, N)");
        }
        e[i][0] = (int)u; e[i][1] = (int)v;
    }
    *outN = (int)N;
    *outEdges = e;
    return (int)M;
}

/* ----------------------------- JSON mode ---------------------------- */

static void emitJson(const Graph *g, const double *PR, int iterations,
                     int converged, double finalDiff, double bestMs,
                     int repeats, double d, double tol, int maxIter,
                     const History *hist)
{
    int N = g->N;

    int dangling = 0;
    for (int i = 0; i < N; i++) if (g->outdeg[i] == 0) dangling++;
    double rankSum = 0.0;
    for (int i = 0; i < N; i++) rankSum += PR[i];

    printf("{\n");
    printf("  \"implementation\": \"serial\",\n");
    printf("  \"nodes\": %d,\n", N);
    printf("  \"edges\": %d,\n", g->E);
    printf("  \"dangling_nodes\": %d,\n", dangling);
    printf("  \"damping\": "); jsonNumber(d);            printf(",\n");
    printf("  \"tolerance\": "); jsonNumber(tol);        printf(",\n");
    printf("  \"max_iterations\": %d,\n", maxIter);
    printf("  \"iterations\": %d,\n", iterations);
    printf("  \"converged\": %s,\n", converged ? "true" : "false");
    printf("  \"final_difference\": "); jsonNumber(finalDiff); printf(",\n");
    printf("  \"timing_ms\": "); jsonNumber(bestMs);     printf(",\n");
    printf("  \"timing_runs\": %d,\n", repeats);
    printf("  \"rank_sum\": "); jsonNumber(rankSum);     printf(",\n");

    printf("  \"pagerank\": [");
    for (int i = 0; i < N; i++) { if (i) fputc(',', stdout); jsonNumber(PR[i]); }
    printf("],\n");

    printf("  \"history_has_vectors\": %s,\n",
           (hist && hist->vectors) ? "true" : "false");
    printf("  \"iteration_history\": [");
    if (hist) {
        for (int s = 0; s < hist->count; s++) {
            if (s) fputc(',', stdout);
            printf("\n    {\"iteration\": %d, \"difference\": ", s);
            if (s == 0) fputs("null", stdout); else jsonNumber(hist->diffs[s]);
            if (hist->vectors) {
                printf(", \"pagerank\": [");
                const double *row = hist->vectors + (size_t)s * hist->vectorLen;
                for (int i = 0; i < N; i++) { if (i) fputc(',', stdout); jsonNumber(row[i]); }
                fputc(']', stdout);
            }
            fputc('}', stdout);
        }
        if (hist->count) fputs("\n  ", stdout);
    }
    printf("]\n");
    printf("}\n");
}

static double argDouble(int argc, char **argv, int i, const char *name) {
    if (i >= argc) { fprintf(stderr, "%s needs a value\n", name); exit(2); }
    return atof(argv[i]);
}

static long argLong(int argc, char **argv, int i, const char *name) {
    if (i >= argc) { fprintf(stderr, "%s needs a value\n", name); exit(2); }
    return atol(argv[i]);
}

static int runJsonMode(int argc, char **argv) {
    double d       = DAMPING;
    double tol     = TOL;
    int    maxIter = MAXITER;
    int    repeats = 1;
    int    wantHistory = 1;
    int    historyCap  = HISTORY_NODE_CAP_DEFAULT;
    int    genN = -1, genDeg = 6;
    unsigned genSeed = 42;

    for (int i = 1; i < argc; i++) {
        if      (!strcmp(argv[i], "--json")) continue;
        else if (!strcmp(argv[i], "--damping"))     d = argDouble(argc, argv, ++i, "--damping");
        else if (!strcmp(argv[i], "--tol"))       tol = argDouble(argc, argv, ++i, "--tol");
        else if (!strcmp(argv[i], "--max-iter")) maxIter = (int)argLong(argc, argv, ++i, "--max-iter");
        else if (!strcmp(argv[i], "--repeat"))   repeats = (int)argLong(argc, argv, ++i, "--repeat");
        else if (!strcmp(argv[i], "--history")) wantHistory = (int)argLong(argc, argv, ++i, "--history");
        else if (!strcmp(argv[i], "--history-cap")) historyCap = (int)argLong(argc, argv, ++i, "--history-cap");
        else if (!strcmp(argv[i], "--generate"))    genN = (int)argLong(argc, argv, ++i, "--generate");
        else if (!strcmp(argv[i], "--degree"))    genDeg = (int)argLong(argc, argv, ++i, "--degree");
        else if (!strcmp(argv[i], "--seed"))     genSeed = (unsigned)argLong(argc, argv, ++i, "--seed");
        else { fprintf(stderr, "unknown option: %s\n", argv[i]); return 2; }
    }

    if (!(d >= 0.0 && d < 1.0))          fail("damping must satisfy 0 <= d < 1");
    if (!(tol > 0.0))                    fail("tolerance must be > 0");
    if (maxIter < 1 || maxIter > 100000) fail("max-iter out of range");
    if (repeats < 1 || repeats > 1000)   fail("repeat out of range");
    if (historyCap < 0)                  fail("history-cap out of range");

    /* ---- obtain the graph -------------------------------------------- */
    int N = 0, E = 0;
    int (*edges)[2] = NULL;
    if (genN >= 0) {
        if (genN > MAX_NODES) fail("generated node count out of range");
        if (genDeg < 0 || genDeg > 1000) fail("degree out of range");
        N = genN;
        E = (N > 0) ? genRandomGraph(N, genDeg, genSeed, &edges) : 0;
    } else {
        E = readGraphFromStdin(&N, &edges);
    }

    if (N == 0) {
        /* Degenerate but legal: answer honestly instead of dividing by zero. */
        printf("{\n  \"implementation\": \"serial\",\n  \"nodes\": 0,\n  \"edges\": 0,\n"
               "  \"dangling_nodes\": 0,\n  \"damping\": ");
        jsonNumber(d);
        printf(",\n  \"tolerance\": "); jsonNumber(tol);
        printf(",\n  \"max_iterations\": %d,\n  \"iterations\": 0,\n"
               "  \"converged\": true,\n  \"final_difference\": 0,\n"
               "  \"timing_ms\": 0,\n  \"timing_runs\": %d,\n  \"rank_sum\": 0,\n"
               "  \"pagerank\": [],\n  \"history_has_vectors\": false,\n"
               "  \"iteration_history\": []\n}\n", maxIter, repeats);
        free(edges);
        return 0;
    }

    Graph g = buildGraph(N, E, edges);
    free(edges);

    double *PR = xmalloc((size_t)N * sizeof(double));

    /* ---- phase 1: TIMED. No history, no printing, no instrumentation. --
       Repeating and keeping the fastest run is standard practice: it is
       the run least polluted by scheduler noise. Nothing is averaged or
       adjusted -- `bestMs` is a wall-clock time we actually observed.   */
    int iterations = 0, converged = 0;
    double finalDiff = 0.0;
    double bestSecs = 1e300;
    for (int r = 0; r < repeats; r++) {
        double t0 = nowSeconds();
        iterations = pagerank(&g, PR, d, tol, maxIter, 0, NULL, &finalDiff, &converged);
        double secs = nowSeconds() - t0;
        if (secs < bestSecs) bestSecs = secs;
    }

    /* ---- phase 2: UNTIMED replay that records the iteration history ----
       The algorithm is deterministic, so this reproduces exactly the
       vectors phase 1 computed -- we just keep them this time. Doing it
       outside the timed region is what keeps `timing_ms` honest.        */
    History  hist;
    History *histPtr = NULL;
    if (wantHistory) {
        hist.capacity  = maxIter + 1;
        hist.count     = 0;
        hist.vectorLen = (N <= historyCap) ? N : 0;
        hist.diffs     = xcalloc((size_t)hist.capacity, sizeof(double));
        hist.vectors   = hist.vectorLen
            ? xmalloc((size_t)hist.capacity * (size_t)hist.vectorLen * sizeof(double))
            : NULL;
        histPtr = &hist;
        pagerank(&g, PR, d, tol, maxIter, 0, histPtr, &finalDiff, &converged);
    }

    emitJson(&g, PR, iterations, converged, finalDiff, bestSecs * 1000.0,
             repeats, d, tol, maxIter, histPtr);

    if (histPtr) { free(hist.diffs); free(hist.vectors); }
    free(PR);
    freeGraph(&g);
    return 0;
}

/* ------------------ original assignment demo / benchmark ------------- */

static int runDemoMode(void) {
    printf("=========================================================\n");
    printf(" CSS 311 PDC - Assignment I : PageRank (SERIAL VERSION)\n");
    printf(" Name : <FILL_YOUR_NAME>      Roll No : <FILL_YOUR_ROLL_NO>\n");
    printf("=========================================================\n\n");

    /* ---------- Demonstration graph : small hand-verifiable (N=6) --------
       Web graph:  0->1,0->2 | 1->2 | 2->0 | 3->0,3->2 | 4->3,4->5
       (node 5 is a dangling node: no out-links)                          */
    {
        int E = 8;
        int edges[8][2] = {{0,1},{0,2},{1,2},{2,0},{3,0},{3,2},{4,3},{4,5}};
        printf("---- Demonstration graph : N = 6 nodes, E = %d edges ----\n", E);
        Graph g = buildGraph(6, E, edges);
        double PR[6];
        int it = pagerank(&g, PR, DAMPING, TOL, MAXITER, 1, NULL, NULL, NULL);
        printf("Converged in %d iterations\n", it);
        for (int i = 0; i < 6; i++) printf("  PR[%d] = %.6f\n", i, PR[i]);
        double s = 0; for (int i=0;i<6;i++) s += PR[i];
        printf("  (sum of ranks = %.6f, should be ~1.0)\n\n", s);
        freeGraph(&g);
    }

    /* ---------- Test Cases : small / medium / large, increasing N -------
       Historical/reference benchmark. The live benchmark in the web UI
       runs this same code through --json --generate, on demand.        */
    int sizes[] = {1000, 10000, 100000};
    const char *labels[] = {"small", "medium", "large"};
    int deg = 6;
    printf("---- Test Cases : random graphs, increasing N, avg out-deg = %d ----\n", deg);
    printf("%10s %10s %10s %10s %14s\n", "Size", "N", "E", "Iters", "Time(sec)");
    for (int t = 0; t < 3; t++) {
        int N = sizes[t];
        int (*edges)[2];
        int E = genRandomGraph(N, deg, 42, &edges);
        Graph g = buildGraph(N, E, edges);
        double *PR = xmalloc((size_t)N * sizeof(double));

        clock_t start = clock();
        int it = pagerank(&g, PR, DAMPING, TOL, MAXITER, 0, NULL, NULL, NULL);
        clock_t end = clock();
        double secs = (double)(end - start) / CLOCKS_PER_SEC;

        printf("%10s %10d %10d %10d %14.6f\n", labels[t], N, E, it, secs);

        free(PR); free(edges); freeGraph(&g);
    }
    printf("\nDone.\n");
    return 0;
}

int main(int argc, char **argv) {
    for (int i = 1; i < argc; i++)
        if (!strcmp(argv[i], "--json")) { g_jsonMode = 1; break; }

    if (g_jsonMode) return runJsonMode(argc, argv);
    if (argc > 1) {
        fprintf(stderr, "usage: %s            (demo + benchmark, human readable)\n", argv[0]);
        fprintf(stderr, "       %s --json ... (machine-readable, graph on stdin)\n", argv[0]);
        return 2;
    }
    return runDemoMode();
}
