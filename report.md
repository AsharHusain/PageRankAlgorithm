# PageRank benchmark report

## Module I — Serial PageRank context

PageRank iteratively distributes rank through incoming edges. With incoming CSR, each iteration scans vertices and edges, giving O(N + E) work and O(N + E) graph storage. The benchmark uses the five graph cases below; each listed timing is derived from successful timed result rows, excluding warmups.

| Case | N | E | Serial median (s) |
|---|---:|---:|---:|
| N10 | 10 | 11 | 1.587e-06 |
| N100 | 100 | 594 | 8.7861e-05 |
| N1000 | 1,000 | 5,994 | 0.000441013 |
| N10000 | 10,000 | 59,995 | 0.001829857 |
| N100000 | 100,000 | 599,992 | 0.009252197 |

## Module III — MPI

### Q6. Foster PCAM

Partition destination vertices among processes. Communicate global dangling mass, new rank values, and convergence error through collective reductions and an all-gather. Agglomerate each process's destination range into one work unit; map those ranges to MPI processes. This describes the algorithmic model; implementation details should be checked against the current source.

### Q7. Execution outline

Initialize the graph and ranks, repeatedly reduce dangling mass, update owned destinations, exchange the new vector, reduce convergence error, then stop at convergence. Timing summaries below come from the benchmark comparison data.

### Q8. Benchmark configurations

The benchmark suite exercises N10, N100, N1000, N10000, and N100000. Per-configuration summaries require at least five successful timed readings; warmups and unsuccessful attempts are not used in summary statistics.

### Q9. MPI results

| Case | Serial (s) | MPI/1 (s) | MPI/2 (s) | MPI/4 (s) |
|---|---:|---:|---:|---:|
| N10 | 1.587e-06 | 2.1303e-05 | 6.4743e-05 | 0.000138717 |
| N100 | 8.7861e-05 | 6.634e-05 | 0.000116308 | 0.000284884 |
| N1000 | 0.000441013 | 0.000296401 | 0.000256088 | 0.000350771 |
| N10000 | 0.001829857 | 0.001930254 | 0.001254603 | 0.001029242 |
| N100000 | 0.009252197 | 0.011137435 | 0.006543447 | 0.005660108 |

### Q10. Complexity

For N vertices, E edges, I iterations, and P processes, balanced local update work is approximately O(I(N + E)/P); collective costs and load imbalance add overhead. Confirm exact memory distribution and collectives against the implementation before making source-specific claims.

### Q11. Timing, speedup and efficiency

Elapsed time is the benchmark's application-reported compute time. Speedup is serial median / configuration median; efficiency is speedup / worker count. The SVG and PNG are produced by scripts/benchmark.py and are referenced, not redrawn here.

| Case | OMP/1 | OMP/2 | OMP/4 | MPI/1 | MPI/2 | MPI/4 |
|---|---:|---:|---:|---:|---:|---:|
| N10 | 0.073× / 0.073 | 0.004× / 0.002 | 0.003× / 0.001 | 0.074× / 0.074 | 0.025× / 0.012 | 0.011× / 0.003 |
| N100 | 0.777× / 0.777 | 0.100× / 0.050 | 0.087× / 0.022 | 1.324× / 1.324 | 0.755× / 0.378 | 0.308× / 0.077 |
| N1000 | 0.601× / 0.601 | 0.403× / 0.201 | 0.437× / 0.109 | 1.488× / 1.488 | 1.722× / 0.861 | 1.257× / 0.314 |
| N10000 | 0.987× / 0.987 | 0.835× / 0.418 | 0.919× / 0.230 | 0.948× / 0.948 | 1.459× / 0.729 | 1.778× / 0.444 |
| N100000 | 0.878× / 0.878 | 1.295× / 0.647 | 1.122× / 0.281 | 0.831× / 0.831 | 1.414× / 0.707 | 1.635× / 0.409 |

![Benchmark median runtime](outputs/comparison.svg)

![Benchmark median runtime PNG](outputs/comparison.png)

### Provenance

```text
Machine: Linux-7.2.5-3-omarchy-x86_64-with-glibc2.44
CPU model: Intel(R) Core(TM) Ultra 9 185H
Architecture: x86_64
Logical CPUs reported by Python: 22
CPUs available to this process: 22
GCC: gcc (GCC) 16.2.1 20260810
MPI compiler: gcc (GCC) 16.2.1 20260810
MPI launcher: mpirun (Open MPI) 5.0.10
Root MPI override used: no
Benchmark command: python3 scripts/benchmark.py (working directory /home/ash/Documents/College/Sem5/PADC/PageRank)
Compilation commands:
  gcc -O2 -std=c11 -Wall -Wextra -pedantic /home/ash/Documents/College/Sem5/PADC/PageRank/c/serial_pagerank.c -o /home/ash/Documents/College/Sem5/PADC/PageRank/outputs/bin/serial_pagerank
  gcc -O2 -std=c11 -Wall -Wextra -pedantic -fopenmp /home/ash/Documents/College/Sem5/PADC/PageRank/c/openmp_pagerank.c -o /home/ash/Documents/College/Sem5/PADC/PageRank/outputs/bin/openmp_pagerank
  mpicc -O2 -std=c11 -Wall -Wextra -pedantic /home/ash/Documents/College/Sem5/PADC/PageRank/c/mpi_pagerank.c -o /home/ash/Documents/College/Sem5/PADC/PageRank/outputs/bin/mpi_pagerank
Timing scope: application-reported compute_elapsed; graph generation and process startup excluded.
MPI timing is the maximum elapsed time across ranks.
All executions use -O2 -std=c11 -Wall -Wextra -pedantic; OpenMP adds -fopenmp.
Invocation patterns include --graph1, --graph2, --demo, --case CASE, and --emit-ranks.
Demos: graph1 N=4 E=5; graph2 N=4 E=4; demo N=6 E=8.
Cases: N10 (explicit fixture, E=11), N100 (E=594), N1000 (E=5994), N10000 (E=59995), N100000 (E=599992).
Each configuration has one warmup and at least 5 successful timed readings; at most 10 timed attempts.
Generated cases use affine pair(k)=((N+1)*k+17) mod N^2; offset/seed=17, self-loops skipped, directed pairs unique. N10 is an explicit E=11 fixture (seed not applicable).
OpenMP threads: 1,2,4; MPI processes: 1,2,4.
OpenMP environment: OMP_NUM_THREADS=worker count, OMP_DYNAMIC=FALSE; MPI root override is recorded above when used.
Validation: finite ranks, rank sum within 1e-08, final L1 error < 1e-06; benchmark max rank delta <= 1e-08, demo delta <= 1e-10; Iterations may differ; rank vectors are compared by maximum absolute delta.
```

Validated inputs: per-implementation `*_results.csv`, `comparison.csv`, `metadata.txt`, and the benchmark's raw `*_output.txt` smoke-test logs. Summary statistics are recomputed from successful timed readings; no timing or machine values are embedded in this generator.
