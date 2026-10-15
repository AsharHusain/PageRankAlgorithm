#include "shared_graph.h"

#include <mpi.h>

int main(int argc, char **argv)
{
    int rank_id, world_size;
    PRCase c;
    PRGraph graph = {0};
    double *rank = NULL, *next = NULL, *local_values = NULL;
    double final_error = 0.0;
    int *counts = NULL, *displacements = NULL;
    size_t begin, end, local_n, iterations = 0;
    int success = 0;

    if (MPI_Init(&argc, &argv) != MPI_SUCCESS)
        return EXIT_FAILURE;
    if (MPI_Comm_rank(MPI_COMM_WORLD, &rank_id) != MPI_SUCCESS ||
        MPI_Comm_size(MPI_COMM_WORLD, &world_size) != MPI_SUCCESS)
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    if (!pr_parse_case(argc, argv, &c)) {
        if (rank_id == 0) pr_usage(argv[0]);
        MPI_Finalize();
        return EXIT_FAILURE;
    }
    /* Replicated deterministic graph: each rank stores the same incoming CSR,
     * and owns only a contiguous range of vertices for each update. */
    if (!pr_graph_build(&graph, &c) || !pr_graph_valid(&graph)) {
        if (rank_id == 0) fprintf(stderr, "Unable to construct graph\n");
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    }
    if (world_size <= 0 || graph.n > (size_t)INT_MAX) {
        if (rank_id == 0) fprintf(stderr, "Graph partition exceeds MPI count limits\n");
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    }
    begin = graph.n * (size_t)rank_id / (size_t)world_size;
    end = graph.n * (size_t)(rank_id + 1) / (size_t)world_size;
    local_n = end - begin;
    rank = pr_initial_ranks(graph.n);
    next = pr_rank_vector(graph.n);
    local_values = local_n > SIZE_MAX / sizeof(*local_values) ? NULL :
        (double *)malloc((local_n == 0 ? 1 : local_n) * sizeof(*local_values));
    if ((size_t)world_size > SIZE_MAX / sizeof(*counts) ||
        (size_t)world_size > SIZE_MAX / sizeof(*displacements))
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    counts = (int *)malloc((size_t)world_size * sizeof(*counts));
    displacements = (int *)malloc((size_t)world_size * sizeof(*displacements));
    if (rank == NULL || next == NULL || local_values == NULL || counts == NULL || displacements == NULL) {
        fprintf(stderr, "Rank %d: unable to allocate rank vectors\n", rank_id);
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    }
    for (int p = 0; p < world_size; ++p) {
        const size_t first = graph.n * (size_t)p / (size_t)world_size;
        const size_t last = graph.n * (size_t)(p + 1) / (size_t)world_size;
        if (last - first > (size_t)INT_MAX || first > (size_t)INT_MAX) {
            if (rank_id == 0) fprintf(stderr, "MPI count/displacement overflow\n");
            MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
        }
        counts[p] = (int)(last - first);
        displacements[p] = (int)first;
    }

    if (MPI_Barrier(MPI_COMM_WORLD) != MPI_SUCCESS)
        MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
    const double start = MPI_Wtime();
    for (size_t iter = 1; iter <= PR_MAX_ITERATIONS; ++iter) {
        double local_dangling = 0.0, dangling = 0.0;
        double local_error = 0.0, error = 0.0;
        for (size_t v = begin; v < end; ++v)
            if (graph.out_degree[v] == 0) local_dangling += rank[v];
        /* Collective order is identical on all ranks: dangling sum, rank
         * all-gather, then global L1 sum. */
        if (MPI_Allreduce(&local_dangling, &dangling, 1, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD) != MPI_SUCCESS)
            MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
        const double base = (1.0 - PR_DAMPING) / (double)graph.n +
                            PR_DAMPING * dangling / (double)graph.n;
        for (size_t v = begin; v < end; ++v) {
            double incoming = 0.0;
            for (size_t p = graph.in_offsets[v]; p < graph.in_offsets[v + 1]; ++p) {
                const size_t src = (size_t)graph.in_sources[p];
                incoming += rank[src] / (double)graph.out_degree[src];
            }
            local_values[v - begin] = base + PR_DAMPING * incoming;
        }
        /* Gather into a distinct receive vector (no overlapping MPI buffers),
         * making all remote new ranks available for the next iteration. */
        if (MPI_Allgatherv(local_values, (int)local_n, MPI_DOUBLE, next, counts,
                           displacements, MPI_DOUBLE, MPI_COMM_WORLD) != MPI_SUCCESS)
            MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
        for (size_t v = begin; v < end; ++v)
            local_error += next[v] >= rank[v] ? next[v] - rank[v] : rank[v] - next[v];
        if (MPI_Allreduce(&local_error, &error, 1, MPI_DOUBLE, MPI_SUM, MPI_COMM_WORLD) != MPI_SUCCESS)
            MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
        final_error = error;
        { double *tmp = rank; rank = next; next = tmp; }
        iterations = iter;
        if (error < PR_TOLERANCE) { success = 1; break; }
    }
    {
        const double local_elapsed = MPI_Wtime() - start;
        double elapsed = 0.0;
        if (MPI_Reduce(&local_elapsed, &elapsed, 1, MPI_DOUBLE, MPI_MAX, 0, MPI_COMM_WORLD) != MPI_SUCCESS)
            MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
        if (rank_id == 0)
            pr_print_result(&graph, iterations, elapsed, success, final_error,
                            c.emit_ranks, rank);
    }
    free(rank); free(next); free(local_values); free(counts); free(displacements);
    pr_graph_free(&graph);
    MPI_Finalize();
    return success ? EXIT_SUCCESS : EXIT_FAILURE;
}
