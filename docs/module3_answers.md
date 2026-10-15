# Module 3 Answers

> **Superseded draft:** This file contains earlier benchmark readings. Use
> [`report.md`](../report.md) for the current CSV-generated Module I–III answers,
> validated raw results, and comparison graph.

## Q6. Foster PCAM methodology

1. **Partitioning:** Divide vertices into contiguous ranges. Each MPI process owns updates for its range; every process stores the same graph and full current rank vector.
2. **Communication:** Each iteration uses `MPI_Allreduce` for dangling rank and global L1 error, and `MPI_Allgatherv` to assemble the new rank vector. After convergence, `MPI_Reduce` with `MAX` gathers elapsed time.
3. **Agglomeration:** Keep one contiguous vertex range per process and process its incoming CSR edges locally; exchange values collectively rather than edge by edge.
4. **Mapping:** Map one range to each process. For N=6, P=2, process 0 owns 0–2 and process 1 owns 3–5.

```text
             Replicated graph and current full rank vector
                         /                 \
              Process 0: 0..2       Process 1: 3..5
               local dangling         local dangling
                         \                 /
                  Allreduce SUM: dangling
                         /                 \
                 owned new ranks      owned new ranks
                         \                 /
                 Allgatherv: full next vector
                         /                 \
                 local L1 error       local L1 error
                         \                 /
                   Allreduce SUM: error
```

## Q7. MPI algorithm pseudocode

```text
MPI_Init; obtain process id p and process count P
Each process independently builds the same deterministic graph and CSR
N = number of vertices
begin = floor(N*p/P); end = floor(N*(p+1)/P)
Initialize full rank vector to 1/N; prepare all-gather counts/displacements
MPI_Barrier; start timer

for iteration = 1 to maximum iterations:
    local_dangling = sum(rank[v] for begin <= v < end if out_degree[v] = 0)
    MPI_Allreduce SUM(local_dangling) -> dangling
    base = (1 - damping)/N + damping*dangling/N
    For each owned v, compute local_next[v] = base + damping *
        sum(rank[u]/out_degree[u] for each incoming edge u -> v)
    MPI_Allgatherv(local_next ranges) -> full next vector on every process
    local_error = sum(abs(next[v] - rank[v]) for owned v)
    MPI_Allreduce SUM(local_error) -> global error
    Swap rank and next
    if global error < tolerance: stop

local_elapsed = timer - start
MPI_Reduce MAX(local_elapsed) to process 0
Process 0 prints result row and, for N=6, ranks
Free storage; MPI_Finalize
```

The iteration collectives occur in this order: dangling `MPI_Allreduce`, rank `MPI_Allgatherv`, and error `MPI_Allreduce`. The timer starts after graph/rank setup and a barrier; the maximum elapsed time is reduced after the loop.

## Q8. Six-node demonstration

The demo graph has six vertices and exactly these eight directed edges:

```text
0 -> 1    0 -> 2    1 -> 2    2 -> 0
3 -> 0    3 -> 2    4 -> 3    4 -> 5
```

Vertex 5 is dangling. With two processes, the formula `begin=floor(N*p/P)`, `end=floor(N*(p+1)/P)` assigns vertices 0–2 to process 0 and 3–5 to process 1. Each independently constructs the full graph; per iteration they sum dangling rank, update their owned vertices, all-gather new ranks, then sum their local L1 errors. Per the reported corrected runs, serial, OpenMP, and MPI converge in 25 iterations and agree to at least four decimal places. The reported ranks, in vertex order 0–5, are:

```text
0.348745053419
0.179540061955
0.351119739754
0.044635865309
0.031323414252
0.044635865309
```

## Q9. Implementation and demo commands

The implementation is in `c/serial_pagerank.c`, `c/openmp_pagerank.c`, and `c/mpi_pagerank.c`; shared graph generation, demo graph, CSR, and constants are in `c/shared_graph.h`. From the repository root, compile with warnings enabled and run the six-node demo:

```sh
gcc -O2 -std=c11 -Wall -Wextra -pedantic c/serial_pagerank.c -o serial
gcc -O2 -std=c11 -Wall -Wextra -pedantic -fopenmp c/openmp_pagerank.c -o openmp
mpicc -O2 -std=c11 -Wall -Wextra -pedantic c/mpi_pagerank.c -o mpi

./serial --demo
OMP_NUM_THREADS=2 ./openmp --demo
mpirun -np 2 ./mpi --demo
```

The programs print `N,E,iterations,elapsed_seconds,status`; the recorded MPI/2 demo row is `6,8,25,0.000059268,success`. It is followed by `ranks` and the six values listed in Q8. This is the actual recorded run; elapsed time varies between runs.

## Q10. Time, memory, and communication complexity

Let N be vertices, E edges, I iterations, and P processes. The graph CSR and full current/next rank vectors are replicated, so memory is **O(N+E) per process** (plus O(N/P) local new-rank values); aggregate graph storage is O(P(N+E)). Deterministic graph construction costs O(N+E) work per process and is outside the timer.

With balanced vertex and edge work, local computation per iteration is O((N+E)/P), so I iterations cost O(I(N+E)/P) local work. More precisely, an iteration scans O(N/P) owned vertices and processes their incoming edges; uneven degree distribution can make edge work imbalanced. Every iteration all-gathers N rank values, requiring O(N) data per process (O(PN) aggregate for the collective) and typically O(log P) collective latency. The two scalar all-reductions per iteration add small payloads and collective latency. Runtime also includes synchronization and communication; MPI reports the maximum process elapsed time, reduced after the loop.

## Q11. Benchmark results

Three runs were made for each case and implementation/worker count; the table reports median computation-only elapsed times. All readings succeeded, with 43, 30, and 16 iterations for the small, medium, and large cases, respectively. MPI time is the maximum elapsed time across ranks; graph generation is excluded. The machine was a Core Ultra 9 185H system, using GCC 16.2.1 and Open MPI 5.0.10.

Speedup is `serial median / parallel median`; efficiency is `speedup / workers`. The OpenMP and MPI columns use four workers/processes.

| N | E | Serial median (s) | OpenMP/4 median (s) | MPI/4 median (s) | Iterations | MPI processes | OpenMP/4 speedup / efficiency | MPI/4 speedup / efficiency |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 5,994 | 0.000573003 | 0.001110154 | 0.000277286 | 43 | 4 | 0.516 / 0.129 | 2.066 / 0.517 |
| 10,000 | 59,995 | 0.002418502 | 0.001809015 | 0.001245836 | 30 | 4 | 1.337 / 0.334 | 1.941 / 0.485 |
| 100,000 | 599,992 | 0.009879651 | 0.006764354 | 0.004177516 | 16 | 4 | 1.461 / 0.365 | 2.365 / 0.591 |

For reference, the OpenMP/2 median times (small/medium/large) were 0.000938571/0.002893609/0.009145877 s; MPI/2 medians were 0.000231532/0.001176599/0.006466347 s, corresponding to speedups 2.475/2.056/1.528. The OpenMP/4 run is slower than serial on the smallest case. The greater-than-P MPI/2 speedups on the two smaller cases are not robust scalability evidence: these sub-millisecond measurements are sensitive to timing noise, cache effects, and measurement overhead. Treat both effects cautiously.

See the [comparison plot](../outputs/comparison.svg). Source data: [`outputs/comparison.csv`](../outputs/comparison.csv), [`outputs/metadata.txt`](../outputs/metadata.txt), and raw readings in [`outputs/serial_output.txt`](../outputs/serial_output.txt), [`outputs/openmp_output.txt`](../outputs/openmp_output.txt), and [`outputs/mpi_output.txt`](../outputs/mpi_output.txt).
