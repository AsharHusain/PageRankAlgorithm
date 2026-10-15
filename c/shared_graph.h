#ifndef PAGERANK_SHARED_GRAPH_H
#define PAGERANK_SHARED_GRAPH_H

#include <stddef.h>
#include <stdint.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PR_DAMPING 0.85
#define PR_TOLERANCE 1e-6
#ifndef PR_MAX_ITERATIONS
#define PR_MAX_ITERATIONS 10000
#endif

static uint64_t pr_mul_mod(uint64_t a, uint64_t b, uint64_t mod)
{
    uint64_t result = 0;
    a %= mod;
    while (b != 0) {
        if (b & 1U)
            result = result >= mod - a ? result - (mod - a) : result + a;
        b >>= 1;
        if (b != 0)
            a = a >= mod - a ? a - (mod - a) : a + a;
    }
    return result;
}

typedef struct {
    size_t n;
    size_t e;
    size_t *in_offsets;
    int *in_sources;
    size_t *out_degree;
} PRGraph;

typedef struct {
    size_t n;
    size_t e;
    int demo;
    int emit_ranks;
    int graph_kind;
} PRCase;

static int pr_graph_allocate(PRGraph *g, size_t n, size_t e)
{
    if (n == 0 || n > (size_t)INT32_MAX || n == SIZE_MAX ||
        n + 1 > SIZE_MAX / sizeof(*g->in_offsets) ||
        e > SIZE_MAX / sizeof(*g->in_sources) ||
        n > SIZE_MAX / sizeof(*g->out_degree))
        return 0;
    g->n = n;
    g->e = e;
    g->in_offsets = (size_t *)calloc(n + 1, sizeof(*g->in_offsets));
    g->in_sources = (int *)malloc((e == 0 ? 1 : e) * sizeof(*g->in_sources));
    g->out_degree = (size_t *)calloc(n, sizeof(*g->out_degree));
    if (g->in_offsets == NULL || g->in_sources == NULL || g->out_degree == NULL) {
        free(g->in_offsets);
        free(g->in_sources);
        free(g->out_degree);
        memset(g, 0, sizeof(*g));
        return 0;
    }
    return 1;
}

/* A fixed affine permutation of all possible directed pairs makes generation
 * reproducible and collision-free. Self loops are skipped; pairs are unique. */
static int pr_graph_generate(PRGraph *g, size_t n, size_t wanted_edges)
{
    size_t made = 0;
    size_t k = 0;
    const uint64_t domain = (uint64_t)n * (uint64_t)n;
    const uint64_t multiplier = (uint64_t)n + 1;

    if (n == 0 || n > (size_t)INT32_MAX ||
        wanted_edges > (uint64_t)n * (uint64_t)(n - 1))
        return 0;
    if (!pr_graph_allocate(g, n, wanted_edges))
        return 0;

    while (made < wanted_edges) {
        uint64_t pair = pr_mul_mod(multiplier, (uint64_t)k, domain);
        const uint64_t offset = 17U % domain;
        pair = pair >= domain - offset ? pair - (domain - offset) : pair + offset;
        const size_t src = (size_t)(pair / n);
        const size_t dst = (size_t)(pair % n);
        ++k;
        if (src == dst)
            continue;
        ++g->in_offsets[dst + 1];
        ++g->out_degree[src];
        g->in_sources[made++] = (int)src;
    }

    for (size_t v = 0; v < n; ++v)
        g->in_offsets[v + 1] += g->in_offsets[v];

    /* Fill CSR sources in destination order. Regenerate the same pair stream. */
    {
        size_t *cursor = (size_t *)malloc(n * sizeof(*cursor));
        if (cursor == NULL) {
            free(g->in_offsets);
            free(g->in_sources);
            free(g->out_degree);
            memset(g, 0, sizeof(*g));
            return 0;
        }
        memcpy(cursor, g->in_offsets, n * sizeof(*cursor));
        made = 0;
        k = 0;
        while (made < wanted_edges) {
            uint64_t pair = pr_mul_mod(multiplier, (uint64_t)k, domain);
            const uint64_t offset = 17U % domain;
            pair = pair >= domain - offset ? pair - (domain - offset) : pair + offset;
            const size_t src = (size_t)(pair / n);
            const size_t dst = (size_t)(pair % n);
            ++k;
            if (src != dst) {
                g->in_sources[cursor[dst]++] = (int)src;
                ++made;
            }
        }
        free(cursor);
    }
    return 1;
}

static int pr_graph_from_edges(PRGraph *g, size_t n,
                               const int (*edges)[2], size_t e)
{
    if (n == 0 || n > (size_t)INT32_MAX)
        return 0;
    for (size_t i = 0; i < e; ++i)
        if (edges[i][0] < 0 || edges[i][1] < 0 ||
            (size_t)edges[i][0] >= n || (size_t)edges[i][1] >= n)
            return 0;
    if (!pr_graph_allocate(g, n, e))
        return 0;
    for (size_t i = 0; i < e; ++i) {
        const size_t src = (size_t)edges[i][0];
        const size_t dst = (size_t)edges[i][1];
        ++g->in_offsets[dst + 1];
        ++g->out_degree[src];
    }
    for (size_t v = 0; v < n; ++v)
        g->in_offsets[v + 1] += g->in_offsets[v];
    {
        size_t *cursor = (size_t *)malloc(n * sizeof(*cursor));
        if (cursor == NULL) {
            free(g->in_offsets);
            free(g->in_sources);
            free(g->out_degree);
            memset(g, 0, sizeof(*g));
            return 0;
        }
        memcpy(cursor, g->in_offsets, n * sizeof(*cursor));
        for (size_t i = 0; i < e; ++i) {
            const size_t src = (size_t)edges[i][0];
            const size_t dst = (size_t)edges[i][1];
            g->in_sources[cursor[dst]++] = (int)src;
        }
        free(cursor);
    }
    return 1;
}

/* Six-node demo, with exact directed edges: 0->1, 0->2, 1->2, 2->0,
 * 3->0, 3->2, 4->3, and 4->5. Node 5 is dangling. */
static int pr_graph_demo(PRGraph *g)
{
    static const int edges[][2] = {
        {0, 1}, {0, 2}, {1, 2}, {2, 0},
        {3, 0}, {3, 2}, {4, 3}, {4, 5}
    };
    return pr_graph_from_edges(g, 6, edges, sizeof(edges) / sizeof(edges[0]));
}

static int pr_graph_n10(PRGraph *g)
{
    static const int edges[][2] = {
        {0, 1}, {0, 2}, {1, 2}, {2, 0}, {3, 0}, {3, 2},
        {4, 3}, {4, 5}, {6, 7}, {7, 8}, {8, 6}
    };
    return pr_graph_from_edges(g, 10, edges, sizeof(edges) / sizeof(edges[0]));
}

/* Four-node examples transcribed from the supplied PageRank PDF. */
static int pr_graph1(PRGraph *g)
{
    static const int edges[][2] = {
        {0, 1}, {0, 2}, {1, 3}, {2, 3}, {3, 0}
    };
    return pr_graph_from_edges(g, 4, edges, sizeof(edges) / sizeof(edges[0]));
}

static int pr_graph2(PRGraph *g)
{
    static const int edges[][2] = {
        {0, 1}, {1, 2}, {2, 0}, {1, 3}
    };
    return pr_graph_from_edges(g, 4, edges, sizeof(edges) / sizeof(edges[0]));
}

static int pr_graph_build(PRGraph *g, const PRCase *c)
{
    switch (c->graph_kind) {
    case 1: return pr_graph_demo(g);
    case 2: return pr_graph1(g);
    case 3: return pr_graph2(g);
    case 4: return pr_graph_n10(g);
    default: return pr_graph_generate(g, c->n, c->e);
    }
}

static int pr_graph_valid(const PRGraph *g)
{
    if (g->n == 0 || g->n > (size_t)INT32_MAX || g->in_offsets == NULL ||
        g->in_sources == NULL || g->out_degree == NULL ||
        g->in_offsets[0] != 0 || g->in_offsets[g->n] != g->e)
        return 0;
    for (size_t v = 0; v < g->n; ++v)
        if (g->in_offsets[v] > g->in_offsets[v + 1] ||
            g->in_offsets[v + 1] > g->e)
            return 0;
    for (size_t p = 0; p < g->e; ++p)
        if (g->in_sources[p] < 0 || (size_t)g->in_sources[p] >= g->n ||
            g->out_degree[g->in_sources[p]] == 0)
            return 0;
    return 1;
}

static void pr_graph_free(PRGraph *g)
{
    free(g->in_offsets);
    free(g->in_sources);
    free(g->out_degree);
    memset(g, 0, sizeof(*g));
}

static int pr_parse_case(int argc, char **argv, PRCase *c)
{
    int selector_seen = 0;
    c->demo = 0;
    c->emit_ranks = 0;
    c->graph_kind = 0;
    c->n = 1000;
    c->e = 5994;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--demo") == 0) {
            if (selector_seen++) return 0;
            c->demo = 1;
            c->graph_kind = 1;
        } else if (strcmp(argv[i], "--graph1") == 0) {
            if (selector_seen++) return 0;
            c->demo = 0;
            c->graph_kind = 2;
        } else if (strcmp(argv[i], "--graph2") == 0) {
            if (selector_seen++) return 0;
            c->demo = 0;
            c->graph_kind = 3;
        } else if (strcmp(argv[i], "--emit-ranks") == 0) {
            c->emit_ranks = 1;
        } else if (strcmp(argv[i], "--case") == 0 && i + 1 < argc) {
            if (selector_seen++) return 0;
            const char *name = argv[++i];
            if (strcmp(name, "N1") == 0) {
                c->n = 1; c->e = 0;
            } else if (strcmp(name, "N10") == 0) {
                c->n = 10; c->e = 11; c->graph_kind = 4;
            } else if (strcmp(name, "N100") == 0) {
                c->n = 100; c->e = 594;
            } else if (strcmp(name, "N1000") == 0 || strcmp(name, "small") == 0) {
                c->n = 1000; c->e = 5994;
            } else if (strcmp(name, "N10000") == 0 || strcmp(name, "medium") == 0) {
                c->n = 10000; c->e = 59995;
            } else if (strcmp(name, "N100000") == 0 || strcmp(name, "large") == 0) {
                c->n = 100000; c->e = 599992;
            } else {
                return 0;
            }
        } else {
            return 0;
        }
    }
    return 1;
}

static void pr_usage(const char *program)
{
    fprintf(stderr, "Usage: %s [--demo | --graph1 | --graph2 | --case N1|N10|N100|N1000|N10000|N100000|small|medium|large] [--emit-ranks]\n", program);
}

static double *pr_initial_ranks(size_t n)
{
    if (n == 0 || n > SIZE_MAX / sizeof(double))
        return NULL;
    double *ranks = (double *)malloc(n * sizeof(*ranks));
    if (ranks != NULL)
        for (size_t i = 0; i < n; ++i)
            ranks[i] = 1.0 / (double)n;
    return ranks;
}

static double *pr_rank_vector(size_t n)
{
    return n == 0 || n > SIZE_MAX / sizeof(double) ? NULL :
           (double *)malloc(n * sizeof(double));
}

static void pr_print_result(const PRGraph *g, size_t iterations,
                            double elapsed, int success, double final_error,
                            int emit_ranks, const double *ranks)
{
    printf("%zu,%zu,%zu,%.9f,%s,%.17g\n", g->n, g->e, iterations, elapsed,
           success ? "success" : "max_iterations", final_error);
    if (g->n <= 6 && !emit_ranks) {
        printf("ranks");
        for (size_t i = 0; i < g->n; ++i)
            printf(",%.12f", ranks[i]);
        putchar('\n');
    } else if (emit_ranks) {
        printf("ranks");
        for (size_t i = 0; i < g->n; ++i)
            printf(",%.17g", ranks[i]);
        putchar('\n');
    }
}

#endif
