#include "shared_graph.h"

#include <omp.h>

int main(int argc, char **argv)
{
    PRCase c;
    PRGraph graph = {0};
    double *rank, *next;
    double final_error = 0.0;
    size_t iterations = 0;
    int success = 0;
    if (!pr_parse_case(argc, argv, &c)) {
        pr_usage(argv[0]);
        return EXIT_FAILURE;
    }
    if (!pr_graph_build(&graph, &c) || !pr_graph_valid(&graph)) {
        fprintf(stderr, "Unable to construct graph\n");
        return EXIT_FAILURE;
    }
    rank = pr_initial_ranks(graph.n);
    next = pr_rank_vector(graph.n);
    if (rank == NULL || next == NULL) {
        fprintf(stderr, "Unable to allocate rank vectors\n");
        free(rank); free(next); pr_graph_free(&graph);
        return EXIT_FAILURE;
    }
    const double start = omp_get_wtime();
    for (size_t iter = 1; iter <= PR_MAX_ITERATIONS; ++iter) {
        double dangling = 0.0, error = 0.0;
        /* Reduction order can vary slightly between threads; convergence uses
         * the same L1 tolerance for every implementation. */
        #pragma omp parallel for reduction(+:dangling) schedule(static)
        for (size_t v = 0; v < graph.n; ++v)
            if (graph.out_degree[v] == 0) dangling += rank[v];
        const double base = (1.0 - PR_DAMPING) / (double)graph.n +
                            PR_DAMPING * dangling / (double)graph.n;
        #pragma omp parallel for schedule(static)
        for (size_t v = 0; v < graph.n; ++v) {
            double incoming = 0.0;
            for (size_t p = graph.in_offsets[v]; p < graph.in_offsets[v + 1]; ++p) {
                const size_t src = (size_t)graph.in_sources[p];
                incoming += rank[src] / (double)graph.out_degree[src];
            }
            next[v] = base + PR_DAMPING * incoming;
        }
        #pragma omp parallel for reduction(+:error) schedule(static)
        for (size_t v = 0; v < graph.n; ++v)
            error += next[v] >= rank[v] ? next[v] - rank[v] : rank[v] - next[v];
        final_error = error;
        { double *tmp = rank; rank = next; next = tmp; }
        iterations = iter;
        if (error < PR_TOLERANCE) { success = 1; break; }
    }
    const double elapsed = omp_get_wtime() - start;
    pr_print_result(&graph, iterations, elapsed, success, final_error,
                    c.emit_ranks, rank);
    free(rank); free(next); pr_graph_free(&graph);
    return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
