/* =====================================================================
   CSS 311 - Parallel and Distributed Computing : Assignment I
   Topic     : PageRank Algorithm - PARALLEL VERSION (OpenMP, C)
   Name      : <FILL_YOUR_NAME>
   Roll No   : <FILL_YOUR_ROLL_NO>

   Same algorithm and same CSR data structures as serial_pagerank.c; the
   only difference is that the three per-node loops inside one power
   iteration are executed by an OpenMP thread team.

   ---------------------------------------------------------------------
   THIS PROGRAM HAS TWO MODES
   ---------------------------------------------------------------------
     (1) No arguments  -> the original assignment behaviour: demonstration
                          graph, benchmark suite, and the 1/2/4/8-thread
                          speed-up study, printed human-readably.
                          (This is what outputs/openmp_output.txt captured.)

     (2) --json        -> reads an ARBITRARY graph and prints one
                          machine-readable JSON object on stdout. This is
                          the mode the web backend invokes: the threads
                          reported by the browser are the threads that
                          really ran here.

   JSON-mode graph input (stdin, whitespace separated):

        N M
        u1 v1
        ...
        uM vM

   Options (JSON mode): everything serial_pagerank.c accepts, plus
     --threads <t>       size of the OpenMP thread team (default: omp default)

   Example:
        printf '3 3\n0 1\n1 2\n2 0\n' | ./openmp_pagerank --json --threads 4
   ===================================================================== */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <omp.h>

#define DAMPING   0.85
#define TOL       1e-6
#define MAXITER   100

#define HISTORY_NODE_CAP_DEFAULT 1000

#define MAX_NODES   5000000
#define MAX_EDGES  40000000

static int g_jsonMode = 0;

typedef struct {
    int N, E;
    int *outdeg;
    int *inStart;
    int *inList;
} Graph;

typedef struct {
    int     capacity;
    int     count;
    int     vectorLen;
    double *diffs;
    double *vectors;
} History;

/* --------------------------- small helpers -------------------------- */

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

static void jsonNumber(double v) {
    if (isfinite(v)) printf("%.12g", v);
    else             fputs("null", stdout);
}

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

Graph buildGraph(int N, int E, int (*edges)[2]) {
    Graph g; g.N = N; g.E = E;
    g.outdeg = xcalloc((size_t)N, sizeof(int));
    int *inCount = xcalloc((size_t)N, sizeof(int));
    for (int e = 0; e < E; e++) { g.outdeg[edges[e][0]]++; inCount[edges[e][1]]++; }
    g.inStart = xmalloc(((size_t)N + 1) * sizeof(int));
    g.inStart[0] = 0;
    for (int i = 0; i < N; i++) g.inStart[i + 1] = g.inStart[i] + inCount[i];
    g.inList = xmalloc((size_t)E * sizeof(int));
    int *cursor = xmalloc((size_t)N * sizeof(int));
    memcpy(cursor, g.inStart, (size_t)N * sizeof(int));
    for (int e = 0; e < E; e++) { int v = edges[e][1]; g.inList[cursor[v]++] = edges[e][0]; }
    free(inCount); free(cursor);
    return g;
}
void freeGraph(Graph *g) { free(g->outdeg); free(g->inStart); free(g->inList); }

/* ---------------------------- the algorithm ------------------------- */

/* Parallel power-iteration PageRank.
   - The per-node update newPR[v] is independent across v  -> #pragma omp parallel for
     (this is the ONLY genuinely parallelizable block; see Q6 in the report)
   - danglingSum and diff are global scalars               -> reduction clauses
   - An implicit barrier at the end of each parallel-for enforces that ALL
     nodes finish iteration k before iteration k+1 starts (data dependency
     between successive iterations forces this synchronization).

   `hist` may be NULL. When it is NULL the loop carries no instrumentation
   at all, which is the variant we time.                                */
int pagerank_parallel(const Graph *g, double *PR, double d, double tol, int maxIter,
                      int verbose, History *hist, double *finalDiff, int *converged)
{
    int N = g->N;
    double *newPR = xmalloc((size_t)N * sizeof(double));
    for (int i = 0; i < N; i++) PR[i] = 1.0 / N;

    if (hist) {
        hist->count = 1;
        hist->diffs[0] = 0.0;
        if (hist->vectors) memcpy(hist->vectors, PR, (size_t)N * sizeof(double));
    }

    double diff = 0.0;
    int conv = 0;
    int iter;
    for (iter = 0; iter < maxIter; iter++) {
        double danglingSum = 0.0;
        #pragma omp parallel for reduction(+:danglingSum)
        for (int u = 0; u < N; u++) if (g->outdeg[u] == 0) danglingSum += PR[u];

        #pragma omp parallel for schedule(static)
        for (int v = 0; v < N; v++) {
            double sum = 0.0;
            for (int k = g->inStart[v]; k < g->inStart[v + 1]; k++) {
                int u = g->inList[k];
                sum += PR[u] / g->outdeg[u];
            }
            newPR[v] = (1.0 - d) / N + d * (sum + danglingSum / N);
        }

        diff = 0.0;
        #pragma omp parallel for reduction(+:diff)
        for (int i = 0; i < N; i++) diff += fabs(newPR[i] - PR[i]);
        memcpy(PR, newPR, (size_t)N * sizeof(double));

        if (hist && hist->count < hist->capacity) {
            int slot = hist->count++;
            hist->diffs[slot] = diff;
            if (hist->vectors)
                memcpy(hist->vectors + (size_t)slot * hist->vectorLen,
                       PR, (size_t)N * sizeof(double));
        }

        if (verbose) printf("  iter %2d : L1 diff = %.8f\n", iter + 1, diff);
        if (diff < tol) { iter++; conv = 1; break; }
    }
    free(newPR);
    if (finalDiff) *finalDiff = diff;
    if (converged) *converged = conv;
    return iter;
}

int genRandomGraph(int N, int deg, unsigned seed, int (**edges)[2]) {
    srand(seed);
    long long cap = (long long)N * deg;
    if (cap > MAX_EDGES) fail("generated graph would exceed the edge limit");
    int (*e)[2] = xmalloc((size_t)cap * sizeof(*e));
    int E = 0;
    for (int u = 0; u < N; u++)
        for (int k = 0; k < deg; k++) {
            int v = rand() % N;
            if (v == u) continue;
            e[E][0] = u; e[E][1] = v; E++;
        }
    *edges = e;
    return E;
}

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

/* ------------------- real thread-team instrumentation ----------------
   Two facts the UI wants that only OpenMP itself can tell us:

     threadsUsed  -- how many threads the runtime ACTUALLY gave the team
                     (a request for 8 on a 4-core box may be honoured or
                     not; we report what really happened).
     owner[v]     -- which thread `schedule(static)` really assigned node
                     v to, obtained by asking omp_get_thread_num() from
                     inside a parallel-for with the identical clause.

   Both are measured in their own region, entirely OUTSIDE the timed
   solve, so this instrumentation cannot distort timing_ms.           */
static int measureThreadTeam(int N, int *owner) {
    int threadsUsed = 0;

    #pragma omp parallel
    {
        #pragma omp master
        threadsUsed = omp_get_num_threads();
    }

    #pragma omp parallel for schedule(static)
    for (int v = 0; v < N; v++) owner[v] = omp_get_thread_num();

    return threadsUsed;
}

/* ----------------------------- JSON mode ---------------------------- */

static void emitJson(const Graph *g, const double *PR, int iterations,
                     int converged, double finalDiff, double bestMs,
                     int repeats, double d, double tol, int maxIter,
                     const History *hist,
                     int threadsRequested, int threadsUsed, int maxThreads,
                     const int *owner)
{
    int N = g->N;

    int dangling = 0;
    for (int i = 0; i < N; i++) if (g->outdeg[i] == 0) dangling++;
    double rankSum = 0.0;
    for (int i = 0; i < N; i++) rankSum += PR[i];

    printf("{\n");
    printf("  \"implementation\": \"openmp\",\n");
    printf("  \"nodes\": %d,\n", N);
    printf("  \"edges\": %d,\n", g->E);
    printf("  \"dangling_nodes\": %d,\n", dangling);
    printf("  \"damping\": "); jsonNumber(d);      printf(",\n");
    printf("  \"tolerance\": "); jsonNumber(tol);  printf(",\n");
    printf("  \"max_iterations\": %d,\n", maxIter);
    printf("  \"iterations\": %d,\n", iterations);
    printf("  \"converged\": %s,\n", converged ? "true" : "false");
    printf("  \"final_difference\": "); jsonNumber(finalDiff); printf(",\n");
    printf("  \"timing_ms\": "); jsonNumber(bestMs); printf(",\n");
    printf("  \"timing_runs\": %d,\n", repeats);
    printf("  \"rank_sum\": "); jsonNumber(rankSum); printf(",\n");
    printf("  \"threads_requested\": %d,\n", threadsRequested);
    printf("  \"threads_used\": %d,\n", threadsUsed);
    printf("  \"max_threads_available\": %d,\n", maxThreads);

    /* Work distribution actually produced by schedule(static). */
    printf("  \"thread_work\": [");
    if (owner && threadsUsed > 0) {
        long long *nodeCount = xcalloc((size_t)threadsUsed, sizeof(long long));
        long long *edgeCount = xcalloc((size_t)threadsUsed, sizeof(long long));
        for (int v = 0; v < N; v++) {
            int t = owner[v];
            if (t < 0 || t >= threadsUsed) continue;
            nodeCount[t]++;
            edgeCount[t] += g->inStart[v + 1] - g->inStart[v];
        }
        for (int t = 0; t < threadsUsed; t++) {
            if (t) fputc(',', stdout);
            printf("\n    {\"thread\": %d, \"nodes\": %lld, \"in_edges\": %lld}",
                   t, nodeCount[t], edgeCount[t]);
        }
        if (threadsUsed) fputs("\n  ", stdout);
        free(nodeCount); free(edgeCount);
    }
    printf("],\n");

    /* Which node each thread owns -- only for graphs small enough that
       the UI can usefully colour every node. */
    printf("  \"node_thread\": [");
    if (owner && N <= 5000)
        for (int v = 0; v < N; v++) { if (v) fputc(',', stdout); printf("%d", owner[v]); }
    printf("],\n");

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
    int    threads = 0;                    /* 0 => leave OpenMP's default */

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
        else if (!strcmp(argv[i], "--threads"))  threads = (int)argLong(argc, argv, ++i, "--threads");
        else { fprintf(stderr, "unknown option: %s\n", argv[i]); return 2; }
    }

    if (!(d >= 0.0 && d < 1.0))          fail("damping must satisfy 0 <= d < 1");
    if (!(tol > 0.0))                    fail("tolerance must be > 0");
    if (maxIter < 1 || maxIter > 100000) fail("max-iter out of range");
    if (repeats < 1 || repeats > 1000)   fail("repeat out of range");
    if (historyCap < 0)                  fail("history-cap out of range");
    if (threads < 0 || threads > 1024)   fail("threads out of range");

    int maxThreads = omp_get_max_threads();
    if (threads > 0) omp_set_num_threads(threads);

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
        printf("{\n  \"implementation\": \"openmp\",\n  \"nodes\": 0,\n  \"edges\": 0,\n"
               "  \"dangling_nodes\": 0,\n  \"damping\": ");
        jsonNumber(d);
        printf(",\n  \"tolerance\": "); jsonNumber(tol);
        printf(",\n  \"max_iterations\": %d,\n  \"iterations\": 0,\n"
               "  \"converged\": true,\n  \"final_difference\": 0,\n"
               "  \"timing_ms\": 0,\n  \"timing_runs\": %d,\n  \"rank_sum\": 0,\n"
               "  \"threads_requested\": %d,\n  \"threads_used\": 0,\n"
               "  \"max_threads_available\": %d,\n  \"thread_work\": [],\n"
               "  \"node_thread\": [],\n  \"pagerank\": [],\n"
               "  \"history_has_vectors\": false,\n  \"iteration_history\": []\n}\n",
               maxIter, repeats, threads, maxThreads);
        free(edges);
        return 0;
    }

    Graph g = buildGraph(N, E, edges);
    free(edges);

    double *PR = xmalloc((size_t)N * sizeof(double));

    /* --- untimed: ask the runtime what the team actually looks like --- */
    int *owner = xmalloc((size_t)N * sizeof(int));
    int threadsUsed = measureThreadTeam(N, owner);

    /* --- phase 1: TIMED, uninstrumented, fastest-of-`repeats` runs ---- */
    int iterations = 0, converged = 0;
    double finalDiff = 0.0;
    double bestSecs = 1e300;
    for (int r = 0; r < repeats; r++) {
        double t0 = omp_get_wtime();
        iterations = pagerank_parallel(&g, PR, d, tol, maxIter, 0, NULL, &finalDiff, &converged);
        double secs = omp_get_wtime() - t0;
        if (secs < bestSecs) bestSecs = secs;
    }

    /* --- phase 2: UNTIMED replay that records the iteration history --- */
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
        pagerank_parallel(&g, PR, d, tol, maxIter, 0, histPtr, &finalDiff, &converged);
    }

    emitJson(&g, PR, iterations, converged, finalDiff, bestSecs * 1000.0,
             repeats, d, tol, maxIter, histPtr,
             threads > 0 ? threads : maxThreads, threadsUsed, maxThreads, owner);

    if (histPtr) { free(hist.diffs); free(hist.vectors); }
    free(owner); free(PR);
    freeGraph(&g);
    return 0;
}

/* ------------------ original assignment demo / benchmark ------------- */

static int runDemoMode(void) {
    printf("=========================================================\n");
    printf(" CSS 311 PDC - Assignment I : PageRank (OpenMP PARALLEL)\n");
    printf(" Name : <FILL_YOUR_NAME>      Roll No : <FILL_YOUR_ROLL_NO>\n");
    printf(" Max hardware threads available : %d\n", omp_get_max_threads());
    printf("=========================================================\n\n");

    /* ---------- Same demonstration graph as serial, correctness check --- */
    {
        int E = 8;
        int edges[8][2] = {{0,1},{0,2},{1,2},{2,0},{3,0},{3,2},{4,3},{4,5}};
        printf("---- Demonstration graph : N = 6 nodes, E = %d edges, 4 threads ----\n", E);
        omp_set_num_threads(4);
        Graph g = buildGraph(6, E, edges);
        double PR[6];
        int it = pagerank_parallel(&g, PR, DAMPING, TOL, MAXITER, 1, NULL, NULL, NULL);
        printf("Converged in %d iterations\n", it);
        for (int i = 0; i < 6; i++) printf("  PR[%d] = %.6f\n", i, PR[i]);
        printf("  (matches serial version's output exactly -> correctness verified)\n\n");
        freeGraph(&g);
    }

    /* ---------- Test Cases : same small/medium/large sizes as serial,
                  fixed at 4 threads (for direct serial-vs-parallel compare) */
    int sizes[] = {1000, 10000, 100000};
    const char *labels[] = {"small", "medium", "large"};
    int deg = 6;
    omp_set_num_threads(4);
    printf("---- Test Cases : random graphs, increasing N, 4 threads ----\n");
    printf("%10s %10s %10s %10s %14s\n", "Size", "N", "E", "Iters", "Time(sec)");
    for (int t = 0; t < 3; t++) {
        int N = sizes[t];
        int (*edges)[2]; int E = genRandomGraph(N, deg, 42, &edges);
        Graph g = buildGraph(N, E, edges);
        double *PR = xmalloc((size_t)N * sizeof(double));
        double start = omp_get_wtime();
        int it = pagerank_parallel(&g, PR, DAMPING, TOL, MAXITER, 0, NULL, NULL, NULL);
        double secs = omp_get_wtime() - start;
        printf("%10s %10d %10d %10d %14.6f\n", labels[t], N, E, it, secs);
        free(PR); free(edges); freeGraph(&g);
    }

    /* ---------- Speed-up study: largest test size, varying thread count - */
    int Nbig = 100000, degBig = 6;
    int (*edges)[2]; int E = genRandomGraph(Nbig, degBig, 42, &edges);
    Graph gBig = buildGraph(Nbig, E, edges);
    printf("\n---- Speed-up study : N = %d (large), E = %d, varying thread count ----\n", Nbig, E);
    printf("%10s %14s %10s\n", "Threads", "Time(sec)", "Speedup");
    double base = 0;
    int threadCounts[] = {1, 2, 4, 8};
    for (int t = 0; t < 4; t++) {
        omp_set_num_threads(threadCounts[t]);
        double *PR = xmalloc((size_t)Nbig * sizeof(double));
        double start = omp_get_wtime();
        pagerank_parallel(&gBig, PR, DAMPING, TOL, MAXITER, 0, NULL, NULL, NULL);
        double secs = omp_get_wtime() - start;
        if (t == 0) base = secs;
        printf("%10d %14.6f %10.2f\n", threadCounts[t], secs, base / secs);
        free(PR);
    }
    free(edges); freeGraph(&gBig);

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
